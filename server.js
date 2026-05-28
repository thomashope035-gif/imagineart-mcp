import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import cors from 'cors';

const BASE_URL = 'https://api.vyro.ai/v2';

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an AI image from a text prompt using ImagineArt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed text description of the image' },
        style: { type: 'string', description: 'Style: realistic, anime, digital-art', default: 'realistic' },
        aspect_ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3', default: '1:1' },
        negative_prompt: { type: 'string', description: 'Things to exclude (optional)' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'generate_video',
    description: 'Generate a video from a text prompt. Returns a video ID — use check_video_status to get the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the video' },
        style: { type: 'string', description: 'Model: kling-1.0-pro, kling-1.5-pro', default: 'kling-1.0-pro' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'image_to_video',
    description: 'Animate an image into a video. Returns a video ID.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image to animate' },
        prompt: { type: 'string', description: 'How the image should animate' },
        style: { type: 'string', default: 'kling-1.0-pro' }
      },
      required: ['image_url', 'prompt']
    }
  },
  {
    name: 'check_video_status',
    description: 'Check video generation status. Returns the video URL when complete.',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'The video ID from generate_video or image_to_video' }
      },
      required: ['video_id']
    }
  },
  {
    name: 'upscale_image',
    description: 'Upscale an image to higher resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image to upscale' }
      },
      required: ['image_url']
    }
  },
  {
    name: 'remove_background',
    description: 'Remove the background from an image.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'URL of the image' }
      },
      required: ['image_url']
    }
  }
];

// ─── Tool Handler ─────────────────────────────────────────────────────────────

async function handleToolCall(name, args) {
  const API_KEY = process.env.IMAGINEART_API_KEY;
  if (!API_KEY) {
    return { content: [{ type: 'text', text: 'Error: IMAGINEART_API_KEY not set.' }] };
  }

  const auth = { 'Authorization': `Bearer ${API_KEY}` };

  try {
    if (name === 'generate_image') {
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'realistic');
      form.append('aspect_ratio', args.aspect_ratio || '1:1');
      if (args.negative_prompt) form.append('negative_prompt', args.negative_prompt);

      const res = await fetch(`${BASE_URL}/image/generations`, {
        method: 'POST',
        headers: { ...auth, ...form.getHeaders() },
        body: form
      });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const buf = await res.buffer();
      return { content: [
        { type: 'text', text: `Image generated! Prompt: "${args.prompt}"` },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
      ]};
    }

    if (name === 'generate_video') {
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'kling-1.0-pro');
      const res = await fetch(`${BASE_URL}/video/text-to-video`, {
        method: 'POST', headers: { ...auth, ...form.getHeaders() }, body: form
      });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const data = await res.json();
      return { content: [{ type: 'text', text: `Video started!\nID: ${data.id}\nStatus: ${data.status}\nUse check_video_status to get the video URL when ready (1-3 mins).` }] };
    }

    if (name === 'image_to_video') {
      const imgRes = await fetch(args.image_url);
      if (!imgRes.ok) return { content: [{ type: 'text', text: `Could not fetch image: ${args.image_url}` }] };
      const imgBuf = await imgRes.buffer();
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'kling-1.0-pro');
      form.append('image', imgBuf, { filename: 'image.jpg', contentType: 'image/jpeg' });
      const res = await fetch(`${BASE_URL}/video/image-to-video`, {
        method: 'POST', headers: { ...auth, ...form.getHeaders() }, body: form
      });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const data = await res.json();
      return { content: [{ type: 'text', text: `Image-to-video started!\nID: ${data.id}\nUse check_video_status to get the URL when ready.` }] };
    }

    if (name === 'check_video_status') {
      const res = await fetch(`${BASE_URL}/video/${args.video_id}/status`, { headers: auth });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const data = await res.json();
      const url = data.video?.url?.generation?.[0];
      if (url) return { content: [{ type: 'text', text: `Video ready!\nURL: ${url}` }] };
      return { content: [{ type: 'text', text: `Status: ${data.status || 'processing'} — check again in 30 seconds.` }] };
    }

    if (name === 'upscale_image') {
      const imgRes = await fetch(args.image_url);
      const imgBuf = await imgRes.buffer();
      const form = new FormData();
      form.append('image', imgBuf, { filename: 'image.jpg', contentType: 'image/jpeg' });
      const res = await fetch(`${BASE_URL}/image/upscale`, {
        method: 'POST', headers: { ...auth, ...form.getHeaders() }, body: form
      });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const buf = await res.buffer();
      return { content: [
        { type: 'text', text: 'Image upscaled!' },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
      ]};
    }

    if (name === 'remove_background') {
      const imgRes = await fetch(args.image_url);
      const imgBuf = await imgRes.buffer();
      const form = new FormData();
      form.append('image', imgBuf, { filename: 'image.jpg', contentType: 'image/jpeg' });
      const res = await fetch(`${BASE_URL}/image/background-remove`, {
        method: 'POST', headers: { ...auth, ...form.getHeaders() }, body: form
      });
      if (!res.ok) return { content: [{ type: 'text', text: `Error ${res.status}: ${await res.text()}` }] };
      const buf = await res.buffer();
      return { content: [
        { type: 'text', text: 'Background removed!' },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
      ]};
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Server error: ${err.message}` }] };
  }
}

// ─── Server Factory ───────────────────────────────────────────────────────────

function createMCPServer() {
  const s = new Server(
    { name: 'imagineart-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await handleToolCall(req.params.name, req.params.arguments || {});
  });
  return s;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());

// StreamableHTTP — what Claude.ai uses
const httpTransports = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  let transport = httpTransports[sessionId];
  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionId, enableJsonResponse: true });
    httpTransports[sessionId] = transport;
    const s = createMCPServer();
    await s.connect(transport);
    transport.on('close', () => delete httpTransports[sessionId]);
  }
  await transport.handleRequest(req, res);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = httpTransports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'No session' });
  }
});

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (httpTransports[sessionId]) delete httpTransports[sessionId];
  res.status(200).end();
});

// Legacy SSE — fallback
const sseTransports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;
  res.on('close', () => delete sseTransports[transport.sessionId]);
  const s = createMCPServer();
  await s.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = sseTransports[req.query.sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'Session not found' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', server: 'imagineart-mcp' }));

// ─── OAuth Metadata (tells Claude.ai no OAuth login is required) ──────────────

const BASE_URL_OAUTH = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${process.env.PORT || 3000}`;

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL_OAUTH,
    authorization_endpoint: `${BASE_URL_OAUTH}/oauth/authorize`,
    token_endpoint: `${BASE_URL_OAUTH}/oauth/token`,
    registration_endpoint: `${BASE_URL_OAUTH}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256']
  });
});

app.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    issuer: BASE_URL_OAUTH,
    authorization_endpoint: `${BASE_URL_OAUTH}/oauth/authorize`,
    token_endpoint: `${BASE_URL_OAUTH}/oauth/token`,
    registration_endpoint: `${BASE_URL_OAUTH}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code']
  });
});

app.post('/oauth/register', (req, res) => {
  const clientId = randomUUID();
  res.status(201).json({
    client_id: clientId,
    client_secret: randomUUID(),
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const code = randomUUID();
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/oauth/token', express.urlencoded({ extended: true }), (req, res) => {
  res.json({
    access_token: randomUUID(),
    token_type: 'bearer',
    expires_in: 86400
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ImagineArt MCP running on port ${PORT}`));
