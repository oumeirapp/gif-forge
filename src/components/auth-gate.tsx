import { useCallback, useEffect, useState, type ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { LoginPage } from "@/components/login-page"
import { fetchSession, onUnauthorized, signOut, type AuthMode } from "@/lib/session"

type GateState =
  | { status: "loading" }
  | { status: "unreachable", message: string }
  | { status: "signed-out", notice?: string }
  | { status: "signed-in", mode: AuthMode }

interface AuthGateProps {
  children: (signOut?: () => void) => ReactNode
}

// Shows the sign-in page in password mode until the server accepts a session, then renders
// the app. In Easy Auth and local modes there is nothing to sign in to here.
export function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<GateState>({ status: "loading" })

  const refresh = useCallback(async (notice?: string) => {
    try {
      const session = await fetchSession()
      setState(session.authenticated ? { status: "signed-in", mode: session.mode } : { status: "signed-out", notice })
    } catch (error) {
      setState({ status: "unreachable", message: error instanceof Error ? error.message : "Could not reach the server" })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => onUnauthorized(() => {
    setState((current) => current.status === "signed-in" && current.mode === "password"
      ? { status: "signed-out", notice: "Your session has ended. Sign in again to continue." }
      : current)
  }), [])

  if (state.status === "loading") return null

  if (state.status === "unreachable") {
    return (
      <main className="login-shell">
        <Alert variant="destructive" className="login-card">
          <AlertCircle />
          <AlertTitle>Server unavailable</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      </main>
    )
  }

  if (state.status === "signed-out") {
    return <LoginPage notice={state.notice} onSignedIn={() => void refresh()} />
  }

  if (state.mode === "password") {
    return children(() => {
      void signOut().finally(() => setState({ status: "signed-out", notice: "You have signed out." }))
    })
  }
  if (state.mode === "easyauth") return children(() => window.location.assign("/.auth/logout"))
  return children()
}
