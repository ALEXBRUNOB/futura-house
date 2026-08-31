module.exports = async function handler(req, res) {
  const required = [
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_VERSION',
  ];
  const optional = [
    'META_APP_SECRET',
    'OPENAI_API_KEY',
    'OFFLINE_OWNER_NAME',
    'OFFLINE_AI_MODEL',
  ];

  const missing = required.filter((key) => !process.env[key]);
  const configured = Object.fromEntries(required.map((key) => [key, Boolean(process.env[key])]));
  const optionalConfigured = Object.fromEntries(optional.map((key) => [key, Boolean(process.env[key])]));

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = missing.length ? 503 : 200;
  res.end(JSON.stringify({
    service: 'modo-offline-whatsapp',
    status: missing.length ? 'configuration_incomplete' : 'ready',
    configured,
    optional: optionalConfigured,
    missing,
    ai: process.env.OPENAI_API_KEY ? 'enabled' : 'fallback_only',
    timestamp: new Date().toISOString(),
  }));
};
