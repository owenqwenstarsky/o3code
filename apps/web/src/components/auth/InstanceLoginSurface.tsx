import { InstanceAccount, normalizeInstanceUrl } from "@t3tools/client-runtime/instance";
import type { InstanceDescriptor } from "@t3tools/contracts/instance";
import * as Effect from "effect/Effect";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import { instanceRequest, runInstance } from "../../instance/instanceState";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const LAST_INSTANCE_URL_KEY = "o3:last-instance-url";
const WORKSPACE_POLL_MS = 3000;
// Pulling the workspace image and installing tools on first start can take a while.
const WORKSPACE_WAIT_MS = 10 * 60 * 1000;

type Step =
  | { readonly kind: "url" }
  | { readonly kind: "credentials"; readonly descriptor: InstanceDescriptor; readonly url: string }
  | { readonly kind: "password"; readonly descriptor: InstanceDescriptor; readonly current: string }
  | {
      readonly kind: "connecting";
      readonly descriptor: InstanceDescriptor;
      readonly message: string;
    };

function defaultInstanceUrl(): string {
  const remembered = window.localStorage.getItem(LAST_INSTANCE_URL_KEY);
  if (remembered) return remembered;
  // The instance serves the web app, so in a browser the page's own origin is the instance.
  return window.desktopBridge === undefined ? window.location.origin : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const attemptWorkspaceConnection = InstanceAccount.pipe(
  Effect.flatMap((account) => account.connectWorkspace),
  Effect.as({ connected: true } as const),
  Effect.catchTags({
    InstanceWorkspaceUnavailableError: (error) =>
      Effect.succeed({ connected: false, reason: error.reason, message: error.message } as const),
  }),
);

const describe = (url: string) =>
  runInstance(InstanceAccount.pipe(Effect.flatMap((account) => account.describe(url))));

export function InstanceLoginSurface({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "url" });
  const [url, setUrl] = useState(defaultInstanceUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoDescribed = useRef(false);

  const submitUrl = async (candidate: string) => {
    setBusy(true);
    setError(null);
    try {
      const descriptor = await describe(candidate);
      const normalized = normalizeInstanceUrl(candidate);
      window.localStorage.setItem(LAST_INSTANCE_URL_KEY, normalized);
      setStep({ kind: "credentials", descriptor, url: normalized });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const describeOnMount = useEffectEvent(() => {
    if (url) void submitUrl(url);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the remembered or same-origin instance for its name once, so the URL step is skipped when it answers
  useEffect(() => {
    if (autoDescribed.current) return;
    autoDescribed.current = true;
    describeOnMount();
  }, []);

  const connectWorkspace = async (descriptor: InstanceDescriptor) => {
    const startedAt = Date.now();
    setStep({ kind: "connecting", descriptor, message: "Opening your workspace…" });
    try {
      for (;;) {
        const attempt = await runInstance(attemptWorkspaceConnection);
        if (attempt.connected) {
          onSignedIn();
          return;
        }
        if (attempt.reason !== "not-ready" || Date.now() - startedAt > WORKSPACE_WAIT_MS) {
          setError(attempt.message);
          setStep({ kind: "connecting", descriptor, message: "Your workspace isn't ready." });
          return;
        }
        setStep({ kind: "connecting", descriptor, message: attempt.message });
        await new Promise((resolve) => setTimeout(resolve, WORKSPACE_POLL_MS));
      }
    } catch (cause) {
      setError(messageOf(cause));
      setStep({ kind: "connecting", descriptor, message: "Your workspace isn't ready." });
    }
  };

  const submitCredentials = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== "credentials") return;
    setBusy(true);
    setError(null);
    try {
      const result = await runInstance(
        InstanceAccount.pipe(
          Effect.flatMap((account) =>
            account.signIn({
              url: step.url,
              email,
              password,
              clientKind: window.desktopBridge === undefined ? "web" : "desktop",
            }),
          ),
        ),
      );
      if (result.user.mustChangePassword) {
        setStep({ kind: "password", descriptor: step.descriptor, current: password });
      } else {
        await connectWorkspace(step.descriptor);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitNewPassword = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== "password") return;
    if (newPassword !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await instanceRequest((client, headers) =>
        client.account.changePassword({
          headers,
          payload: { currentPassword: step.current, newPassword },
        }),
      );
      await connectWorkspace(step.descriptor);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const errorAlert = error ? (
    <Alert variant="error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  if (step.kind === "url") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="Sign in to O3 Code"
          description="Enter your organization's O3 instance address."
        />
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitUrl(url);
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="instance-url">
              Instance address
            </label>
            <Input
              id="instance-url"
              autoCapitalize="none"
              autoComplete="url"
              autoCorrect="off"
              disabled={busy}
              nativeInput
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="o3.your-tailnet.ts.net"
              spellCheck={false}
              value={url}
            />
          </div>
          {errorAlert}
          <Button disabled={busy || url.trim() === ""} size="sm" type="submit">
            {busy ? "Connecting…" : "Continue"}
          </Button>
        </form>
      </StandalonePage>
    );
  }

  if (step.kind === "credentials") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title={`Sign in to ${step.descriptor.name}`}
          description={new URL(step.url).host}
        />
        <form className="mt-6 space-y-4" onSubmit={(event) => void submitCredentials(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="instance-email">
              Email
            </label>
            <Input
              id="instance-email"
              autoCapitalize="none"
              autoComplete="username"
              disabled={busy}
              nativeInput
              onChange={(event) => setEmail(event.currentTarget.value)}
              spellCheck={false}
              type="email"
              value={email}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="instance-password">
              Password
            </label>
            <Input
              id="instance-password"
              autoComplete="current-password"
              disabled={busy}
              nativeInput
              onChange={(event) => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
          </div>
          {errorAlert}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || email === "" || password === ""} size="sm" type="submit">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep({ kind: "url" });
              }}
              size="sm"
              variant="outline"
            >
              Use another instance
            </Button>
          </div>
        </form>
      </StandalonePage>
    );
  }

  if (step.kind === "password") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="Choose a new password"
          description="Your administrator gave you a temporary password. Choose your own to continue."
        />
        <form className="mt-6 space-y-4" onSubmit={(event) => void submitNewPassword(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="instance-new-password">
              New password
            </label>
            <Input
              id="instance-new-password"
              autoComplete="new-password"
              disabled={busy}
              nativeInput
              onChange={(event) => setNewPassword(event.currentTarget.value)}
              type="password"
              value={newPassword}
            />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="instance-confirm-password">
              Confirm new password
            </label>
            <Input
              id="instance-confirm-password"
              autoComplete="new-password"
              disabled={busy}
              nativeInput
              onChange={(event) => setConfirmPassword(event.currentTarget.value)}
              type="password"
              value={confirmPassword}
            />
          </div>
          {errorAlert}
          <Button disabled={busy || newPassword.length < 10} size="sm" type="submit">
            {busy ? "Saving…" : "Save and continue"}
          </Button>
        </form>
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader title={step.descriptor.name} description={step.message} />
      {error ? (
        <div className="mt-6 space-y-4">
          {errorAlert}
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              void connectWorkspace(step.descriptor);
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </StandalonePage>
  );
}
