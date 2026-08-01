'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight, Paperclip, Mic, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Attachment {
  kind: 'image' | 'audio';
  mimeType: string;
  /** base64, no `data:` prefix. */
  data: string;
  name: string;
  /** Local object URL for rendering the thumbnail/player — never sent
   *  to the server, revoked once no longer shown. */
  previewUrl: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  attachment?: Attachment;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
}

/** 5 MB — mirrors MAX_IMAGE_BYTES in src/lib/ai/media.ts and Whisper's
 *  own file-size ceiling, so an oversized pick fails fast client-side
 *  instead of a wasted round-trip. */
const MAX_ATTACHMENT_BYTES = 5_000_000;

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<data>" — keep just the payload.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  // Revoke the object URL when it's replaced/cleared so we don't leak
  // one per attachment picked during the session.
  useEffect(() => {
    return () => {
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const kind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('audio/')
        ? 'audio'
        : null;
    if (!kind) {
      toast.error('Attach an image or an audio file (voice note).');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error('That file is too large — 5 MB max, same as WhatsApp.');
      return;
    }

    try {
      const data = await readBlobAsBase64(file);
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
      setAttachment({
        kind,
        mimeType: file.type,
        data,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
      });
    } catch {
      toast.error('Could not read that file.');
    }
  };

  const removeAttachment = () => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
  };

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error('Could not access the microphone — check your browser permissions.');
      return;
    }

    // Let the browser pick a mimeType it can actually record (varies by
    // browser — Chrome/Firefox default to webm, Safari to mp4); we send
    // whatever it reports back so Whisper gets an accurate content type.
    const recorder = new MediaRecorder(stream);
    recordedChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      stopRecordingTimer();
      const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      try {
        const data = await readBlobAsBase64(blob);
        if (attachment) URL.revokeObjectURL(attachment.previewUrl);
        setAttachment({
          kind: 'audio',
          mimeType: recorder.mimeType || 'audio/webm',
          data,
          name: 'Voice note',
          previewUrl: URL.createObjectURL(blob),
        });
      } catch {
        toast.error('Could not read the recording.');
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    setRecordingSeconds(0);
    recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  };

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const send = async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;

    const pendingAttachment = attachment;
    const userTurn: Turn = {
      role: 'user',
      content: text || (pendingAttachment?.kind === 'image' ? '📷 Photo' : '🎤 Voice note'),
      attachment: pendingAttachment ?? undefined,
    };
    const next: Turn[] = [...turns, userTurn];
    setTurns(next);
    setInput('');
    setAttachment(null);
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content(+attachment on the turn that has one) —
        // the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({
            role: t.role,
            content: t.content,
            ...(t.attachment
              ? {
                  attachment: {
                    kind: t.attachment.kind,
                    mimeType: t.attachment.mimeType,
                    data: t.attachment.data,
                  },
                }
              : {}),
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error('No agent configured yet — finish Setup first.');
        } else if (data.code === 'no_transcription_key') {
          toast.error(data.error ?? 'Add an embeddings key in Setup to transcribe voice notes.', {
            action: onGoToSetup ? { label: 'Go to Setup', onClick: onGoToSetup } : undefined,
          });
        } else {
          toast.error(data.error ?? "Couldn't get a reply.");
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        setAttachment(pendingAttachment);
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content:
            typeof data.reply === 'string' && data.reply.trim()
              ? data.reply
              : '',
          handoff: Boolean(data.handoff),
        },
      ]);
    } catch {
      toast.error("Couldn't reach the agent.");
      setTurns(turns);
      setInput(text);
      setAttachment(pendingAttachment);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Playground</span>
          <span className="text-xs text-muted-foreground">
            — test replies as if you were a customer
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setTurns([]);
            removeAttachment();
          }}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>Send a message to see how your agent would reply.</p>
            <p className="mt-1 text-xs">
              It uses your knowledge base and behaves exactly like the
              auto-reply bot — including handoff. Attach a photo or a
              voice note to test how it handles those too.
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                Not set up yet? Go to Setup <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              t.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {t.role === 'assistant' && (
              <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                t.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {t.attachment?.kind === 'image' && (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not a remote asset
                <img
                  src={t.attachment.previewUrl}
                  alt={t.attachment.name}
                  className="mb-1.5 max-h-48 rounded-lg object-cover"
                />
              )}
              {t.attachment?.kind === 'audio' && (
                <audio controls src={t.attachment.previewUrl} className="mb-1.5 h-8 max-w-56" />
              )}
              {t.content && <p className="whitespace-pre-wrap">{t.content}</p>}
              {t.role === 'assistant' && t.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-500',
                    t.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  Would hand off to a human here
                </p>
              )}
            </div>
            {t.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      {/* Pending attachment preview */}
      {attachment && (
        <div className="flex items-center gap-2 border-t border-border px-3 pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">
            {attachment.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not a remote asset
              <img src={attachment.previewUrl} alt={attachment.name} className="h-8 w-8 rounded object-cover" />
            ) : (
              <Mic className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="max-w-40 truncate">{attachment.name}</span>
            <button
              type="button"
              onClick={removeAttachment}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*"
          className="hidden"
          onChange={onPickFile}
          disabled={sending || recording}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || recording}
          className="h-9 w-9 shrink-0 p-0"
          title="Attach a photo or an audio file"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant={recording ? 'destructive' : 'outline'}
          size="sm"
          onClick={() => (recording ? stopRecording() : void startRecording())}
          disabled={sending}
          className="h-9 w-9 shrink-0 p-0"
          title={recording ? 'Stop recording' : 'Record a voice note'}
        >
          {recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
        </Button>
        {recording ? (
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive" />
            Recording… {formatRecordingTime(recordingSeconds)}
          </div>
        ) : (
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a customer message…"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />
        )}
        <Button
          size="sm"
          onClick={send}
          disabled={(!input.trim() && !attachment) || sending || recording}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
