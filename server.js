import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import FormData from 'form-data';
import fetch from 'node-fetch';

const BASE_URL = 'https://api.vyro.ai/v2';

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'imagineart-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'generate_image',
      description: 'Generate an AI image from a text prompt using ImagineArt. Returns the image directly.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed text description of the image to generate'
          },
          style: {
            type: 'string',
            description: 'Art style. Options: realistic, anime, digital-art, painting, sketch',
            default: 'realistic'
          },
          aspect_ratio: {
            type: 'string',
            description: 'Image dimensions. Options: 1:1, 16:9, 9:16, 4:3, 3:4',
            default: '1:1'
          },
          negative_prompt: {
            type: 'string',
            description: 'Things to exclude from the image (optional)'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'generate_video',
      description: 'Generate a video from a text prompt using ImagineArt. Returns a video ID — use check_video_status to get the result when ready.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed text description of the video to generate'
          },
          style: {
            type: 'string',
            description: 'Video model/style. Options: kling-1.0-pro, kling-1.5-pro',
            default: 'kling-1.0-pro'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'image_to_video',
      description: 'Animate an existing image into a video. Provide an image URL and a motion prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'URL of the image to animate'
          },
          prompt: {
            type: 'string',
            description: 'Description of how the image should animate/move'
          },
          style: {
            type: 'string',
            description: 'Video model/style. Options: kling-1.0-pro, kling-1.5-pro',
            default: 'kling-1.0-pro'
          }
        },
        required: ['image_url', 'prompt']
      }
    },
    {
      name: 'check_video_status',
      description: 'Check the status of a video generation job. Returns the video URL when complete.',
      inputSchema: {
        type: 'object',
        properties: {
          video_id: {
            type: 'string',
            description: 'The video ID returned by generate_video or image_to_video'
          }
        },
        required: ['video_id']
      }
    },
    {
      name: 'upscale_image',
      description: 'Upscale an image to higher resolution using ImagineArt AI.',
      inputSchema: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'URL of the image to upscale'
          }
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
          image_url: {
            type: 'string',
            description: 'URL of the image to remove background from'
          }
        },
        required: ['image_url']
      }
    }
  ]
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const API_KEY = process.env.IMAGINEART_API_KEY;

  if (!API_KEY) {
    return {
      content: [{
        type: 'text',
        text: 'Error: IMAGINEART_API_KEY environment variable is not set. Please add your ImagineArt API key to Railway.'
      }]
    };
  }

  const authHeader = { 'Authorization': `Bearer ${API_KEY}` };

  try {

    // ── Generate Image ──────────────────────────────────────────────────────
    if (name === 'generate_image') {
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'realistic');
      form.append('aspect_ratio', args.aspect_ratio || '1:1');
      if (args.negative_prompt) form.append('negative_prompt', args.negative_prompt);

      const response = await fetch(`${BASE_URL}/image/generations`, {
        method: 'POST',
        headers: { ...authHeader, ...form.getHeaders() },
        body: form
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const buffer = await response.buffer();
      const base64 = buffer.toString('base64');

      return {
        content: [
          { type: 'text', text: `Image generated successfully! Prompt: "${args.prompt}"` },
          { type: 'image', data: base64, mimeType: 'image/jpeg' }
        ]
      };
    }

    // ── Generate Video (Text to Video) ──────────────────────────────────────
    if (name === 'generate_video') {
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'kling-1.0-pro');

      const response = await fetch(`${BASE_URL}/video/text-to-video`, {
        method: 'POST',
        headers: { ...authHeader, ...form.getHeaders() },
        body: form
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const data = await response.json();
      return {
        content: [{
          type: 'text',
          text: `Video generation started!\n\nVideo ID: ${data.id}\nStatus: ${data.status}\n\nVideo generation takes 1-3 minutes. Use check_video_status with ID "${data.id}" to get your video URL when ready.`
        }]
      };
    }

    // ── Image to Video ──────────────────────────────────────────────────────
    if (name === 'image_to_video') {
      const form = new FormData();
      form.append('prompt', args.prompt);
      form.append('style', args.style || 'kling-1.0-pro');

      // Fetch the image and append as buffer
      const imgResponse = await fetch(args.image_url);
      if (!imgResponse.ok) {
        return { content: [{ type: 'text', text: `Could not fetch image from URL: ${args.image_url}` }] };
      }
      const imgBuffer = await imgResponse.buffer();
      form.append('image', imgBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

      const response = await fetch(`${BASE_URL}/video/image-to-video`, {
        method: 'POST',
        headers: { ...authHeader, ...form.getHeaders() },
        body: form
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const data = await response.json();
      return {
        content: [{
          type: 'text',
          text: `Image-to-video generation started!\n\nVideo ID: ${data.id}\nStatus: ${data.status}\n\nUse check_video_status with ID "${data.id}" to get your video URL when ready.`
        }]
      };
    }

    // ── Check Video Status ──────────────────────────────────────────────────
    if (name === 'check_video_status') {
      const response = await fetch(`${BASE_URL}/video/${args.video_id}/status`, {
        headers: authHeader
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const data = await response.json();
      const video = data.video;
      const videoUrl = video?.url?.generation?.[0];
      const thumbnailUrl = video?.url?.thumbnail?.[0];

      if (videoUrl) {
        return {
          content: [{
            type: 'text',
            text: `Video is ready!\n\nStatus: ${data.status}\nVideo URL: ${videoUrl}${thumbnailUrl ? `\nThumbnail: ${thumbnailUrl}` : ''}\n\nOpen the Video URL in your browser to download.`
          }]
        };
      }

      const statusCode = video?.code;
      const statusMessages = {
        0: 'Queued — waiting to start',
        1: 'Processing — generating your video',
        2: 'Complete',
        3: 'Failed'
      };

      return {
        content: [{
          type: 'text',
          text: `Status: ${statusMessages[statusCode] || data.status || 'Processing'}\n\nStill generating. Check again in 30-60 seconds.`
        }]
      };
    }

    // ── Upscale Image ───────────────────────────────────────────────────────
    if (name === 'upscale_image') {
      const imgResponse = await fetch(args.image_url);
      if (!imgResponse.ok) {
        return { content: [{ type: 'text', text: `Could not fetch image from URL: ${args.image_url}` }] };
      }
      const imgBuffer = await imgResponse.buffer();

      const form = new FormData();
      form.append('image', imgBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

      const response = await fetch(`${BASE_URL}/image/upscale`, {
        method: 'POST',
        headers: { ...authHeader, ...form.getHeaders() },
        body: form
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const buffer = await response.buffer();
      const base64 = buffer.toString('base64');
      return {
        content: [
          { type: 'text', text: 'Image upscaled successfully!' },
          { type: 'image', data: base64, mimeType: 'image/jpeg' }
        ]
      };
    }

    // ── Remove Background ───────────────────────────────────────────────────
    if (name === 'remove_background') {
      const imgResponse = await fetch(args.image_url);
      if (!imgResponse.ok) {
        return { content: [{ type: 'text', text: `Could not fetch image from URL: ${args.image_url}` }] };
      }
      const imgBuffer = await imgResponse.buffer();

      const form = new FormData();
      form.append('image', imgBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

      const response = await fetch(`${BASE_URL}/image/background-remove`, {
        method: 'POST',
        headers: { ...authHeader, ...form.getHeaders() },
        body: form
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text', text: `ImagineArt error ${response.status}: ${err}` }] };
      }

      const buffer = await response.buffer();
      const base64 = buffer.toString('base64');
      return {
        content: [
          { type: 'text', text: 'Background removed successfully!' },
          { type: 'image', data: base64, mimeType: 'image/png' }
        ]
      };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

  } catch (error) {
    return { content: [{ type: 'text', text: `Server error: ${error.message}` }] };
  }
});

// ─── Express + SSE Transport ──────────────────────────────────────────────────

const app = express();
const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'Session not found' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', server: 'imagineart-mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ImagineArt MCP server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
