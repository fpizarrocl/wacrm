'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

type Channel = 'instagram' | 'messenger';

interface ConfigStatus {
  connected: boolean;
  page_id?: string;
  ig_business_id?: string | null;
  has_access_token?: boolean;
}

/**
 * One card, reused for both Instagram and Messenger — the two forms
 * are identical (Page ID / IG Business ID / Access Token / Verify
 * Token, manual entry same as WhatsAppConfig) so a single
 * channel-parametrized component avoids duplicating the same ~150
 * lines twice, the same reasoning as AiToolsCard's `type` selector.
 */
export function SocialChannelConfigCard({ channel }: { channel: Channel }) {
  const t = useTranslations('Settings.social');
  const { accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const [pageId, setPageId] = useState('');
  const [igBusinessId, setIgBusinessId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [verifyToken, setVerifyToken] = useState('');

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/social/config?channel=${channel}`);
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        setPageId(data.page_id ?? '');
        setIgBusinessId(data.ig_business_id ?? '');
      } else {
        toast.error(data.error ?? t('loadFailed'));
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [channel, t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === `${channel}:${accountId}`) return;
    loadedAccountIdRef.current = `${channel}:${accountId}`;
    void fetchStatus();
  }, [accountId, channel, fetchStatus]);

  const save = async () => {
    if (!pageId.trim() || !accessToken.trim()) {
      toast.error(t('fieldsRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/social/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          page_id: pageId.trim(),
          ig_business_id: igBusinessId.trim(),
          access_token: accessToken.trim(),
          verify_token: verifyToken.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        if (data.subscribe_warning) {
          toast.warning(`${t('subscribeWarning')}: ${data.subscribe_warning}`);
        }
        setAccessToken('');
        setVerifyToken('');
        await fetchStatus();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    try {
      const res = await fetch(`/api/social/config?channel=${channel}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('disconnectSuccess'));
        setPageId('');
        setIgBusinessId('');
        await fetchStatus();
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('disconnectFailed'));
      }
    } catch {
      toast.error(t('disconnectFailed'));
    }
  };

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/social/webhook` : '/api/social/webhook';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {channel === 'instagram' ? t('instagramTitle') : t('messengerTitle')}
          {!loading &&
            (status?.connected ? (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-green-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> {t('connected')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <XCircle className="h-3.5 w-3.5" /> {t('notConnected')}
              </span>
            ))}
        </CardTitle>
        <CardDescription>{t('webhookUrlHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label>{t('webhookUrl')}</Label>
              <Input value={webhookUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${channel}-page-id`}>{t('pageId')}</Label>
              <Input
                id={`${channel}-page-id`}
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                placeholder={t('pageIdPlaceholder')}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">{t('pageIdHint')}</p>
            </div>
            {channel === 'instagram' && (
              <div className="space-y-2">
                <Label htmlFor={`${channel}-ig-business-id`}>{t('igBusinessId')}</Label>
                <Input
                  id={`${channel}-ig-business-id`}
                  value={igBusinessId}
                  onChange={(e) => setIgBusinessId(e.target.value)}
                  placeholder={t('igBusinessIdPlaceholder')}
                  disabled={saving}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`${channel}-access-token`}>{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  id={`${channel}-access-token`}
                  type={showToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder={status?.has_access_token ? t('accessTokenStoredPlaceholder') : t('accessTokenPlaceholder')}
                  disabled={saving}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${channel}-verify-token`}>{t('verifyToken')}</Label>
              <Input
                id={`${channel}-verify-token`}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder={t('verifyTokenPlaceholder')}
                disabled={saving}
              />
            </div>
            <div className="flex justify-end gap-2">
              {status?.connected && (
                <Button variant="ghost" onClick={disconnect} disabled={saving}>
                  {t('disconnect')}
                </Button>
              )}
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
