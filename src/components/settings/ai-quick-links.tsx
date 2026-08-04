'use client';

import { useState } from 'react';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { slugify } from '@/components/flows/shared';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';

export interface QuickLinkRow {
  key: string;
  label: string;
  url: string;
}

// Mirrors MAX_QUICK_LINKS in src/app/api/ai/config/route.ts — kept in
// sync manually since one lives in a client component and the other in
// a server-only route.
const MAX_QUICK_LINKS = 10;

function nextKey(existing: string[], label: string): string {
  const base = slugify(label, 'link');
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Editable list of quick links (Google Maps, booking site, etc.) the
 * auto-reply agent may offer as tappable WhatsApp buttons — see
 * `LINK_SENTINEL_PATTERN` in `src/lib/ai/defaults.ts` and
 * `src/lib/ai/auto-reply.ts`. Controlled: state lives in `AiConfig`
 * (parent) and is submitted together with the rest of the form, same
 * as `system_prompt` — this isn't a separate CRUD resource like
 * `AiToolsCard`.
 */
export function AiQuickLinksCard({
  value,
  onChange,
  disabled,
}: {
  value: QuickLinkRow[];
  onChange: (rows: QuickLinkRow[]) => void;
  disabled: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const t = useTranslations('Settings.aiQuickLinks');

  const update = (i: number, patch: Partial<QuickLinkRow>) =>
    onChange(value.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const updateLabel = (i: number, label: string) => {
    const row = value[i];
    // Keep the key in sync with the label until the admin has touched
    // it directly (advanced mode) — most links are set-and-forget, so
    // there's no reason to make the id a required field up front.
    const keyIsAuto = row.key === '' || row.key === slugify(row.label, 'link');
    const key = keyIsAuto
      ? nextKey(
          value.filter((_, idx) => idx !== i).map((r) => r.key),
          label,
        )
      : row.key;
    update(i, { label, key });
  };

  const add = () =>
    onChange([...value, { key: nextKey(value.map((r) => r.key), ''), label: '', url: '' }]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {value.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}

        {value.map((row, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border bg-muted/40 p-2">
            <div className="flex items-center gap-2">
              <Input
                value={row.label}
                maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
                onChange={(e) => updateLabel(i, e.target.value)}
                placeholder={t('labelPlaceholder')}
                disabled={disabled}
                className="flex-1 bg-background"
              />
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">
                {row.label.length}/{INTERACTIVE_LIMITS.buttonTitleMaxLength}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(i)}
                disabled={disabled}
                className="h-8 w-8 shrink-0 p-0 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <Input
              value={row.url}
              onChange={(e) => update(i, { url: e.target.value })}
              placeholder={t('urlPlaceholder')}
              disabled={disabled}
              className="bg-background"
            />
            {advanced && (
              <Input
                value={row.key}
                onChange={(e) => update(i, { key: slugify(e.target.value, row.key) })}
                placeholder={t('keyPlaceholder')}
                disabled={disabled}
                className="bg-background font-mono text-xs"
              />
            )}
          </div>
        ))}

        <div className="flex items-center justify-between">
          {value.length < MAX_QUICK_LINKS ? (
            <Button variant="outline" size="sm" onClick={add} disabled={disabled}>
              <Plus className="mr-2 h-4 w-4" /> {t('addLink')}
            </Button>
          ) : (
            <span />
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(e) => setAdvanced(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t('showKeys')}
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
