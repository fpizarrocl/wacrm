import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendSocialText, verifyPage, subscribePageApp } from './send-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendSocialText', () => {
  it('posts to the Page node with the recipient id and bearer token', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ recipient_id: 'psid-1', message_id: 'mid-1' }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendSocialText({
      channel: 'messenger',
      pageId: '123',
      accessToken: 'token-abc',
      recipientId: 'psid-1',
      text: 'hola',
    });

    expect(result).toEqual({ messageId: 'mid-1' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: 'psid-1' },
      messaging_type: 'RESPONSE',
      message: { text: 'hola' },
    });
  });

  it('throws Meta\'s error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Invalid OAuth token' } }, 401)),
    );

    await expect(
      sendSocialText({
        channel: 'instagram',
        pageId: '123',
        accessToken: 'bad',
        recipientId: 'igsid-1',
        text: 'hola',
      }),
    ).rejects.toThrow('Invalid OAuth token');
  });
});

describe('verifyPage', () => {
  it('fetches page metadata with the bearer token', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ id: '123', name: 'My Page' }));
    vi.stubGlobal('fetch', fetchSpy);

    const info = await verifyPage({ pageId: '123', accessToken: 'token-abc' });

    expect(info).toEqual({ id: '123', name: 'My Page' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/123?fields=id,name');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
  });

  it('throws on an invalid page id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Unsupported get request' } }, 400)),
    );

    await expect(verifyPage({ pageId: 'bad', accessToken: 't' })).rejects.toThrow(
      'Unsupported get request',
    );
  });
});

describe('subscribePageApp', () => {
  it('posts to subscribed_apps with the messaging fields', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchSpy);

    await subscribePageApp({ pageId: '123', accessToken: 'token-abc' });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://graph.facebook.com/v21.0/123/subscribed_apps?subscribed_fields=messages,messaging_postbacks',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
  });

  it('rejects when Meta returns an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Missing permission' } }, 403)),
    );

    await expect(subscribePageApp({ pageId: '123', accessToken: 't' })).rejects.toThrow(
      'Missing permission',
    );
  });
});
