<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Product shape

This CRM supports WhatsApp, Instagram, and Messenger as inbound/outbound channels. The AI agent (`src/lib/ai/`) is bring-your-own-key (OpenAI, Anthropic, or Gemini) and understands images and audio — Gemini natively (inline audio/image data sent straight to the model), OpenAI/Anthropic by transcribing voice notes with Whisper first (Claude has no audio-input API at all).
