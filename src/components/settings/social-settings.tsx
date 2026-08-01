'use client';

import { useTranslations } from 'next-intl';
import { SocialChannelConfigCard } from './social-channel-config';

export function SocialSettings() {
  const t = useTranslations('Settings.social');
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <SocialChannelConfigCard channel="instagram" />
      <SocialChannelConfigCard channel="messenger" />
    </div>
  );
}
