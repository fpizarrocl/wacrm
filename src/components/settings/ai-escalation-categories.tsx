'use client';

import { useEffect, useState } from 'react';
import { Tag as TagIcon, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { slugify } from '@/components/flows/shared';
import { createClient } from '@/lib/supabase/client';
import type { Tag } from '@/types';

export interface EscalationCategoryRow {
  key: string;
  label: string;
  tagId: string;
  closingPhrase: string;
}

// Mirrors MAX_ESCALATION_CATEGORIES in src/app/api/ai/config/route.ts —
// kept in sync manually, same as MAX_QUICK_LINKS in ai-quick-links.tsx.
const MAX_CATEGORIES = 10;

function nextKey(existing: string[], label: string): string {
  const base = slugify(label, 'category');
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Editable list of escalation categories — e.g. "Reclamos", "Convenios
 * y Empresas", "Eventos especiales" — the auto-reply agent recognizes
 * by topic and hands off with a fixed, admin-written closing message
 * plus a tag on the contact. See `HANDOFF_SENTINEL_PATTERN` in
 * `src/lib/ai/defaults.ts` and `src/lib/ai/auto-reply.ts`. Controlled,
 * same pattern as `AiQuickLinksCard` — not a separate CRUD resource.
 */
export function AiEscalationCategoriesCard({
  value,
  onChange,
  disabled,
}: {
  value: EscalationCategoryRow[];
  onChange: (rows: EscalationCategoryRow[]) => void;
  disabled: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loadingTags, setLoadingTags] = useState(true);
  const t = useTranslations('Settings.aiEscalationCategories');

  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    supabase
      .from('tags')
      .select('*')
      .order('name')
      .then(({ data }) => {
        if (!alive) return;
        setTags(data ?? []);
        setLoadingTags(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const update = (i: number, patch: Partial<EscalationCategoryRow>) =>
    onChange(value.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const updateLabel = (i: number, label: string) => {
    const row = value[i];
    // Keep the key in sync with the label until the admin has touched
    // it directly (advanced mode) — same rationale as AiQuickLinksCard.
    const keyIsAuto = row.key === '' || row.key === slugify(row.label, 'category');
    const key = keyIsAuto
      ? nextKey(
          value.filter((_, idx) => idx !== i).map((r) => r.key),
          label,
        )
      : row.key;
    update(i, { label, key });
  };

  const add = () =>
    onChange([
      ...value,
      { key: nextKey(value.map((r) => r.key), ''), label: '', tagId: '', closingPhrase: '' },
    ]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TagIcon className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {value.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}

        {!loadingTags && tags.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('noTags')}{' '}
            <a href="/settings?tab=fields" className="text-primary underline">
              {t('noTagsLink')}
            </a>
          </p>
        )}

        {value.map((row, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border bg-muted/40 p-2">
            <div className="flex items-center gap-2">
              <Input
                value={row.label}
                onChange={(e) => updateLabel(i, e.target.value)}
                placeholder={t('labelPlaceholder')}
                disabled={disabled}
                className="flex-1 bg-background"
              />
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
            <Select
              value={row.tagId || undefined}
              onValueChange={(v) => update(i, { tagId: v ?? '' })}
              disabled={disabled || tags.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('tagPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              value={row.closingPhrase}
              onChange={(e) => update(i, { closingPhrase: e.target.value })}
              placeholder={t('closingPhrasePlaceholder')}
              disabled={disabled}
              rows={2}
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">{t('closingPhraseHint')}</p>
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
          {value.length < MAX_CATEGORIES ? (
            <Button variant="outline" size="sm" onClick={add} disabled={disabled}>
              <Plus className="mr-2 h-4 w-4" /> {t('addCategory')}
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
