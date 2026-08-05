"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Sidebar company switcher (migration 054) — only renders anything
 * once `accounts.length > 1`, i.e. only for owners/platform admins
 * who actually have more than one company to switch between. Regular
 * agents and single-company owners never see this; the sidebar's own
 * static account-name strip (unchanged) covers them instead.
 */
export function AccountSwitcher() {
  const t = useTranslations("AccountSwitcher");
  const { account, accounts, switchAccount } = useAuth();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  if (accounts.length <= 1) return null;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("createFailed"));
        return;
      }
      setCreating(false);
      setName("");
      // Full reload into the new company — same as any other switch.
      switchAccount(data.accountId as string);
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60">
          <Building2 className="size-3.5 shrink-0" />
          <span className="truncate" title={account?.name ?? ""}>
            {account?.name}
          </span>
          <ChevronsUpDown className="ml-auto size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          {accounts.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onClick={() => {
                if (a.id !== account?.id) switchAccount(a.id);
              }}
              className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
            >
              <span
                className={cn(
                  "truncate",
                  a.id === account?.id && "font-medium text-foreground",
                )}
              >
                {a.name}
              </span>
              {a.id === account?.id && (
                <Check className="ml-auto size-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setCreating(true)}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <Plus className="mr-2 size-3.5" /> {t("createCompany")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={creating} onOpenChange={(o) => !saving && setCreating(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("createCompanyTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("companyNamePlaceholder")}
            disabled={saving}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
