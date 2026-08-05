import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's *active* account context
// (migration 054) via the `resolve_active_account` RPC — a single
// round trip that reads the `active_account_id` cookie (validated as
// a UUID before being forwarded) and safely falls back to the
// caller's home account for anything invalid/unauthorized. This
// replaced the old two-query (`profiles` then `accounts`) pattern
// entirely, so the RPC call itself is what these tests assert on.

interface RpcCall {
  fn: string;
  args: unknown;
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  rpcResult?: { data: unknown; error: unknown };
}) {
  const rpcCalls: RpcCall[] = [];
  return {
    rpcCalls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return {
          maybeSingle: () =>
            Promise.resolve(opts.rpcResult ?? { data: null, error: null }),
        };
      },
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const cookiesGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: cookiesGet }),
}));

const { getCurrentAccount, UnauthorizedError, ForbiddenError } = await import(
  "./account"
);

afterEach(() => {
  vi.clearAllMocks();
});

const RESOLVED = {
  account_id: "acct-1",
  account_name: "Acme",
  effective_role: "owner",
  default_currency: "USD",
};

describe("getCurrentAccount", () => {
  it("resolves context via resolve_active_account, with no cookie set", async () => {
    cookiesGet.mockReturnValue(undefined);
    const { client, rpcCalls } = makeClient({
      user: { id: "user-1" },
      rpcResult: { data: RESOLVED, error: null },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });
    expect(rpcCalls).toEqual([
      { fn: "resolve_active_account", args: { p_requested_account_id: null } },
    ]);
  });

  it("forwards a valid active_account_id cookie as the requested account", async () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    cookiesGet.mockReturnValue({ value: uuid });
    const { client, rpcCalls } = makeClient({
      user: { id: "user-1" },
      rpcResult: {
        data: { ...RESOLVED, account_id: uuid, account_name: "Other Co" },
        error: null,
      },
    });
    createClient.mockReturnValue(client);

    await getCurrentAccount();

    expect(rpcCalls).toEqual([
      { fn: "resolve_active_account", args: { p_requested_account_id: uuid } },
    ]);
  });

  it("ignores a malformed cookie value instead of forwarding it", async () => {
    cookiesGet.mockReturnValue({ value: "not-a-uuid; DROP TABLE accounts" });
    const { client, rpcCalls } = makeClient({
      user: { id: "user-1" },
      rpcResult: { data: RESOLVED, error: null },
    });
    createClient.mockReturnValue(client);

    await getCurrentAccount();

    expect(rpcCalls[0].args).toEqual({ p_requested_account_id: null });
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps an RPC error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      rpcResult: { data: null, error: { code: "PGRST200" } },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("rejects when resolve_active_account resolves no account at all", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      rpcResult: { data: null, error: null },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an unrecognized effective_role", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      rpcResult: { data: { ...RESOLVED, effective_role: "superuser" }, error: null },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Unknown account role: superuser");
  });
});
