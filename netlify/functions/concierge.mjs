// netlify/functions/concierge.mjs
//
// POST { message: string, history: [{role, content}] } -> { reply, showBooking, suggestions }
//
// Calls the Anthropic Messages API using ANTHROPIC_API_KEY from Netlify's environment
// variables. The key never reaches the browser. If the key is missing, or the API call
// fails for any reason, this function falls back to a local rule-based responder built
// from the demo salon data below (kept in sync with assets/data/demo-salon.json), so the
// page never errors out just because the API isn't configured yet.

const DEMO_SALON = {
  name: 'LUMINA HAIR 福岡',
  description: '福岡市内にある、髪質改善と自然なヘアカラーを得意とする体験用の架空美容室です。',
  hours: '10:00〜20:00',
  closedDay: '火曜日',
  menu: [
    { name: 'カット', price: '5,500円', duration: '約60分' },
    { name: 'カット＋カラー', price: '12,100円', duration: '約120分' },
    { name: '髪質改善トリートメント', price: '9,900円', duration: '約90分' },
    { name: '縮毛矯正', price: '16,500円〜', duration: '約180分' },
    { name: 'ブリーチなしカラー', price: '9,900円〜', duration: '約120分' },
    { name: 'メンズカット', price: '4,950円', duration: '約45分' }
  ],
  availability: ['本日 14:00', '本日 16:30', '明日 11:00', '明日 15:00']
};

const ESCALATION_REPLY = 'こちらはスタッフへの確認が必要です。実際の店舗では、担当者へ引き継ぐことができます。';
const INITIAL_SUGGESTIONS = [
  '今日、空いている時間はありますか？',
  'ブリーチなしでも明るくできますか？',
  '縮毛矯正は何時間かかりますか？',
  '初めてですが、担当者を指名できますか？'
];

const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY = 12;
const RATE_LIMIT_WINDOW_MS = 2000;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Best-effort, per-instance rate limiting. Serverless instances are ephemeral and can run
// concurrently, so this is a simple courtesy guard against accidental rapid double-submits,
// not a hard security boundary.
const rateLimitMap = new Map();

function checkRateLimit(key) {
  const now = Date.now();
  const last = rateLimitMap.get(key) || 0;
  if (now - last < RATE_LIMIT_WINDOW_MS) return false;
  rateLimitMap.set(key, now);
  if (rateLimitMap.size > 500) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS * 10;
    for (const [k, v] of rateLimitMap) if (v < cutoff) rateLimitMap.delete(k);
  }
  return true;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function buildSystemPrompt() {
  const menuLines = DEMO_SALON.menu
    .map((m) => `- ${m.name}：${m.price}（目安${m.duration}）`)
    .join('\n');
  return [
    `あなたは「${DEMO_SALON.name}」の、丁寧で親しみやすいAIコンシェルジュです。`,
    'あなたの目的は、お客様の予約前の疑問や不安を解消し、必要な場合は予約へ自然に案内することです。',
    '',
    '【店舗情報（デモ用）】',
    DEMO_SALON.description,
    `営業時間：${DEMO_SALON.hours}／定休日：${DEMO_SALON.closedDay}`,
    'メニュー：',
    menuLines,
    `本日〜明日のご案内可能時間（デモ表示）：${DEMO_SALON.availability.join(' / ')}`,
    '',
    '【回答ルール】',
    '・必ず日本語で、簡潔で親しみやすく回答してください。一度の回答を長くしすぎないでください。',
    `・上記の店舗情報にない事実を、推測して作らないでください。情報がない場合は「${ESCALATION_REPLY}」のように案内してください。`,
    '・空き時間は必ず「デモ表示」であることが伝わるように案内してください。',
    '・医療的な診断はしないでください。髪や頭皮の異常については、専門家（皮膚科等）への相談を案内してください。',
    '・予約が確定したとは言わないでください。空き時間の案内と、予約への案内にとどめてください。',
    '・質問の意図が不明な場合は、確認の質問を返してください。',
    '・回答の最後に、関連する質問を1つだけ添えても構いません。',
    '・美容師らしい専門用語を使いすぎないでください。',
    '・営業的に押しすぎないでください。',
    '・ホットペッパーや他の集客手段を否定しないでください。'
  ].join('\n');
}

function detectShowBooking(message, reply) {
  return /(予約|空き|空いて|本日|今日|明日|来店)/.test(`${message} ${reply}`);
}

function localReply(message) {
  const t = message;
  const has = (...words) => words.some((w) => t.includes(w));
  const menuLines = DEMO_SALON.menu.map((m) => `${m.name}：${m.price}（${m.duration}）`).join('\n');

  // Specific-topic and availability checks run before the generic 料金/時間
  // catch-alls, because phrases like "縮毛矯正は何時間かかりますか？" or
  // "今日、空いている時間はありますか？" contain the generic word 時間 too.
  if (has('空き', '空い', '予約', 'いつ', '本日', '今日', '明日')) {
    return { reply: `現在ご案内できる目安のお時間です（デモ表示）。\n${DEMO_SALON.availability.join(' / ')}`, showBooking: true, suggestions: ['担当者を指名できますか？', 'キャンセルはできますか？'] };
  }
  if (has('指名', '担当', 'スタイリスト')) {
    return { reply: 'はい、ご指名可能です。ご希望のスタイリストがいらっしゃれば、予約時にお申し付けください。', showBooking: true, suggestions: ['今日、空いている時間はありますか？'] };
  }
  if (has('初めて', '初回', 'はじめて')) {
    return { reply: '初めてのご来店でも安心です。当日はカウンセリングでお悩みやご希望を丁寧にお伺いします。', showBooking: false, suggestions: ['髪質改善について教えてください', '今日の空き時間はありますか？'] };
  }
  if (has('ブリーチ')) {
    return { reply: 'ブリーチなしでも、明るめのカラーに近づけるメニューをご用意しています（ブリーチなしカラー　9,900円〜／約120分）。', showBooking: true, suggestions: ['縮毛矯正は何時間かかりますか？'] };
  }
  if (has('縮毛矯正', 'くせ毛', 'クセ毛')) {
    return { reply: '縮毛矯正は16,500円〜、施術時間の目安は約180分です。髪の状態によって前後する場合があります。', showBooking: true, suggestions: ['髪質改善トリートメントについて'] };
  }
  if (has('髪質')) {
    return { reply: '髪質改善トリートメントは9,900円、約90分です。うねりや広がりが気になる方に人気のメニューです。', showBooking: false, suggestions: ['料金一覧を見る'] };
  }
  if (has('メンズ', '男性')) {
    return { reply: 'メンズカットは4,950円、約45分でご案内しています。', showBooking: true, suggestions: ['今日の空き時間はありますか？'] };
  }
  if (has('営業時間', '何時から', '定休')) {
    return { reply: `営業時間は${DEMO_SALON.hours}、定休日は${DEMO_SALON.closedDay}です。`, showBooking: false, suggestions: ['今日の空き時間はありますか？'] };
  }
  if (has('料金', 'いくら', '価格', '値段')) {
    return { reply: `メニューの目安料金です。\n${menuLines}`, showBooking: false, suggestions: ['所要時間も教えてください', '今日の空き時間はありますか？'] };
  }
  if (has('時間', '所要', '何分', 'どれくらい')) {
    return { reply: `施術時間の目安です。\n${menuLines}`, showBooking: false, suggestions: ['料金も教えてください', '空いている時間はありますか？'] };
  }
  return { reply: ESCALATION_REPLY, showBooking: false, suggestions: INITIAL_SUGGESTIONS };
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  const clientKey =
    req.headers.get('x-nf-client-connection-ip') ||
    (context && context.ip) ||
    'anonymous';
  if (!checkRateLimit(clientKey)) {
    return jsonResponse(429, {
      reply: '少し間隔をあけてから、もう一度お試しください。',
      showBooking: false,
      suggestions: INITIAL_SUGGESTIONS
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
  const rawHistory = Array.isArray(payload?.history) ? payload.history : [];

  if (!message) return jsonResponse(400, { error: 'empty_message' });
  if (message.length > MAX_MESSAGE_LENGTH) return jsonResponse(400, { error: 'message_too_long' });

  const safeHistory = rawHistory
    .slice(-MAX_HISTORY)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(200, localReply(message));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system: buildSystemPrompt(),
        messages: [...safeHistory, { role: 'user', content: message }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Never surface upstream error details to the browser.
      return jsonResponse(200, localReply(message));
    }

    const data = await res.json();
    const replyText = Array.isArray(data?.content)
      ? data.content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
      : '';

    if (!replyText) return jsonResponse(200, localReply(message));

    return jsonResponse(200, {
      reply: replyText,
      showBooking: detectShowBooking(message, replyText),
      suggestions: INITIAL_SUGGESTIONS
    });
  } catch {
    clearTimeout(timeout);
    return jsonResponse(200, localReply(message));
  }
};
