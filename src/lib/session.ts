export type AuthMode = "password" | "easyauth" | "none"

export interface SessionStatus {
  mode: AuthMode
  authenticated: boolean
}

const UNAUTHORIZED_EVENT = "fallback-forge:unauthorized"

// Any API call that gets a 401 reports it here, so the auth gate can show the sign-in page
// again when a session expires mid-use.
export function notifyUnauthorized() {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

export function onUnauthorized(listener: () => void) {
  window.addEventListener(UNAUTHORIZED_EVENT, listener)
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener)
}

async function readSession(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as (SessionStatus & { error?: string }) | null
  if (!response.ok) throw new Error(body?.error ?? fallback)
  return body as SessionStatus
}

export async function fetchSession() {
  return readSession(await fetch("/api/session"), "Could not reach the server")
}

export async function signIn(password: string) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
  return readSession(response, `Sign-in failed (status ${response.status})`)
}

export async function signOut() {
  await fetch("/api/session", { method: "DELETE" })
}
