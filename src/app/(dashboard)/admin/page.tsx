"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Building2,
  Check,
  Loader2,
  Pencil,
  ShieldAlert,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/hooks/use-auth";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface AdminAccount {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

interface PlatformAdminRow {
  user_id: string;
  email: string;
  granted_at: string;
}

/**
 * Platform-admin console (migration 054) — browse/enter any account
 * in the instance, and manage who else has platform-admin (root)
 * access. Every mutation here is re-checked server-side against
 * `is_platform_admin()`; the client-side gate below is purely UX —
 * hitting the APIs directly without the role still 403s.
 */
export default function AdminPage() {
  const t = useTranslations("Admin");
  const { isPlatformAdmin, profileLoading, switchAccount } = useAuth();

  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [search, setSearch] = useState("");
  const [admins, setAdmins] = useState<PlatformAdminRow[] | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [granting, setGranting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renaming, setRenaming] = useState(false);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/admin/accounts");
    const data = await res.json().catch(() => ({}));
    if (res.ok) setAccounts(data.accounts ?? []);
    else toast.error(data.error ?? t("loadAccountsFailed"));
  }, [t]);

  const loadAdmins = useCallback(async () => {
    const res = await fetch("/api/admin/admins");
    const data = await res.json().catch(() => ({}));
    if (res.ok) setAdmins(data.admins ?? []);
    else toast.error(data.error ?? t("loadAdminsFailed"));
  }, [t]);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    void loadAccounts();
    void loadAdmins();
  }, [isPlatformAdmin, loadAccounts, loadAdmins]);

  if (profileLoading) return null;

  if (!isPlatformAdmin) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("notAuthorized")}</p>
      </div>
    );
  }

  const filteredAccounts = (accounts ?? []).filter((a) =>
    a.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const handleGrant = async () => {
    const email = newEmail.trim();
    if (!email) return;
    setGranting(true);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("grantFailed"));
        return;
      }
      toast.success(t("grantSuccess"));
      setNewEmail("");
      await loadAdmins();
    } catch {
      toast.error(t("grantFailed"));
    } finally {
      setGranting(false);
    }
  };

  const startEditing = (account: AdminAccount) => {
    setEditingId(account.id);
    setEditingName(account.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName("");
  };

  const handleRename = async (accountId: string) => {
    const name = editingName.trim();
    if (!name) return;
    setRenaming(true);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("renameFailed"));
        return;
      }
      toast.success(t("renameSuccess"));
      setAccounts((prev) =>
        prev
          ? prev.map((a) => (a.id === accountId ? { ...a, name } : a))
          : prev,
      );
      cancelEditing();
    } catch {
      toast.error(t("renameFailed"));
    } finally {
      setRenaming(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!window.confirm(t("revokeConfirm"))) return;
    const res = await fetch(`/api/admin/admins/${userId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t("revokeFailed"));
      return;
    }
    toast.success(t("revokeSuccess"));
    await loadAdmins();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <ShieldAlert className="h-6 w-6 text-primary" /> {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-primary" /> {t("accountsTitle")}
          </CardTitle>
          <CardDescription>{t("accountsDescription")}</CardDescription>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="mt-2"
          />
        </CardHeader>
        <CardContent>
          {accounts === null ? (
            <div className="flex items-center py-4 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noAccounts")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {filteredAccounts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  {editingId === a.id ? (
                    <>
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(a.id);
                          if (e.key === "Escape") cancelEditing();
                        }}
                        disabled={renaming}
                        autoFocus
                        className="h-8"
                      />
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={renaming || !editingName.trim()}
                          onClick={() => handleRename(a.id)}
                        >
                          {renaming ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={renaming}
                          onClick={cancelEditing}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("createdAt", {
                            date: formatDistanceToNow(new Date(a.created_at), {
                              addSuffix: true,
                            }),
                          })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditing(a)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => switchAccount(a.id)}>
                          {t("enter")}
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-primary" /> {t("adminsTitle")}
          </CardTitle>
          <CardDescription>{t("adminsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder={t("emailPlaceholder")}
              disabled={granting}
            />
            <Button onClick={handleGrant} disabled={granting || !newEmail.trim()}>
              {granting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              {t("grant")}
            </Button>
          </div>
          {admins === null ? (
            <div className="flex items-center py-2 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {admins.map((a) => (
                <li
                  key={a.user_id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="truncate text-sm text-foreground">{a.email}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRevoke(a.user_id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
