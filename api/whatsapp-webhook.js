const crypto = require('crypto');

const REQUIRED_ENV = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_GRAPH_VERSION',
];

const HIGH_RISK = [
  /\b(pix|transfer[eê]ncia|pagamento|boleto|cobran[cç]a|dinheiro|valor|empr[eé]stimo|financiamento)\b/i,
  /\b(contrato|assinar|assinatura|aceite|procura[cç][aã]o|jur[ií]dico|processo|a[cç][aã]o judicial|intima[cç][aã]o)\b/i,
  /\b(senha|c[oó]digo|token|autenticador|2fa|cart[aã]o|cvv|conta banc[aá]ria)\b/i,
  /\b(diagn[oó]stico|receita|medicamento|dose|emerg[eê]ncia m[eé]dica)\b/i,
];

const URGENT = [
  /\b(urgente|urg[eê]ncia|agora|imediato|imediatamente|prazo hoje|vence hoje|vencimento hoje)\b/i,
  /\b(fraude|invas[aã]o|hack|conta bloqueada|seguran[cç]a)\b/i,
  /\b(samu|192|risco de vida|suic[ií]dio|me matar|morrer)\b/i,
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value.messages || []) {
        const contact = (value.contacts || []).find((c) => c.wa_id === message.from) || value.contacts?.[0] || {};
        out.push({
          from: message.from,
          id: message.id,
          type: message.type,
          name: contact?.profile?.name || '',
          text: message?.text?.body || '',
          timestamp: message.timestamp,
        });
      }
    }
  }
  return out;
}

function signatureIsValid(rawBody, signature) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

async function sendWhatsAppText(to, body) {
  const version = process.env.WHATSAPP_GRAPH_VERSION;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: body.slice(0, 4096) },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${detail.slice(0, 600)}`);
  }
  return response.json();
}

function fallbackReply(name) {
  const first = normalizeText(name).split(' ')[0];
  return `${first ? `Olá, ${first}. ` : 'Olá. '}Recebi sua mensagem. Estou em modo de atendimento assistido agora. Vou organizar sua solicitação e, se ela exigir uma decisão pessoal, ela ficará separada para minha confirmação.`;
}

async function generateAIReply({ name, text }) {
  if (!process.env.OPENAI_API_KEY) return fallbackReply(name);

  const ownerName = process.env.OFFLINE_OWNER_NAME || 'Alex Bruno';
  const model = process.env.OFFLINE_AI_MODEL || 'gpt-5.6-luna';
  const instructions = `Você é o assistente operacional de ${ownerName} no Modo Offline. Responda mensagens de WhatsApp em português brasileiro, de forma humana, curta, educada e objetiva. Você pode resolver apenas assuntos rotineiros e informativos. Nunca confirme pagamentos, transferências, contratos, dívidas, compras, demissões, contratações, decisões jurídicas, dados bancários, senhas, códigos, diagnósticos ou prescrições. Nunca invente fatos. Se faltar informação essencial, diga que a solicitação foi registrada e que será confirmada. Não diga que é o próprio ${ownerName}; quando necessário, identifique-se como atendimento assistido dele.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input: `Nome do contato: ${normalizeText(name) || 'não informado'}\nMensagem: ${normalizeText(text)}`,
      max_output_tokens: 240,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error('OpenAI error', response.status, detail.slice(0, 600));
    return fallbackReply(name);
  }

  const data = await response.json();
  if (data.output_text) return normalizeText(data.output_text);
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return normalizeText(parts.join('\n')) || fallbackReply(name);
}

async function handleIncoming(message) {
  const text = normalizeText(message.text);
  const display = message.name || message.from;

  if (message.type !== 'text' || !text) {
    console.log(JSON.stringify({ event: 'offline_non_text', from: message.from, type: message.type, id: message.id }));
    await sendWhatsAppText(message.from, 'Recebi sua mensagem. No momento, o atendimento automático está processando melhor mensagens em texto. Se puder, escreva resumidamente o que você precisa.');
    return;
  }

  const highRisk = HIGH_RISK.some((rule) => rule.test(text));
  const urgent = URGENT.some((rule) => rule.test(text));

  if (highRisk || urgent) {
    console.warn(JSON.stringify({
      event: 'offline_escalation',
      urgent,
      highRisk,
      from: message.from,
      name: display,
      text: text.slice(0, 800),
      messageId: message.id,
    }));

    const response = urgent
      ? 'Recebi sua mensagem e ela foi marcada como prioridade. Esse assunto exige confirmação humana antes de qualquer decisão. Se houver risco imediato à vida ou à segurança, procure o serviço de emergência adequado agora.'
      : 'Recebi sua mensagem. Esse assunto exige uma confirmação pessoal antes de qualquer decisão ou autorização. Deixei a solicitação registrada para análise.';

    await sendWhatsAppText(message.from, response);
    return;
  }

  const reply = await generateAIReply({ name: message.name, text });
  console.log(JSON.stringify({ event: 'offline_auto_reply', from: message.from, name: display, messageId: message.id }));
  await sendWhatsAppText(message.from, reply);
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.statusCode = 200;
      return res.end(String(challenge || ''));
    }
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST');
    return res.end('Method Not Allowed');
  }

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error('WhatsApp configuration missing:', missing.join(', '));
    res.statusCode = 503;
    return res.end('Configuration incomplete');
  }

  const rawBody = await readRawBody(req);
  if (!signatureIsValid(rawBody, req.headers['x-hub-signature-256'])) {
    res.statusCode = 401;
    return res.end('Invalid signature');
  }

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.statusCode = 400;
    return res.end('Invalid JSON');
  }

  if (payload.object !== 'whatsapp_business_account') {
    res.statusCode = 200;
    return res.end('EVENT_RECEIVED');
  }

  const messages = extractMessages(payload);
  res.statusCode = 200;
  res.end('EVENT_RECEIVED');

  for (const message of messages) {
    try {
      await handleIncoming(message);
    } catch (error) {
      console.error('WhatsApp webhook processing error', error?.stack || error?.message || String(error));
    }
  }
};
