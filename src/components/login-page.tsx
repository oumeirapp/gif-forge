import { useState, type FormEvent } from "react"
import { AlertCircle, Aperture, LogIn } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { signIn } from "@/lib/session"

interface LoginPageProps {
  notice?: string
  onSignedIn: () => void
}

export function LoginPage({ notice, onSignedIn }: LoginPageProps) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      await signIn(password)
      onSignedIn()
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in failed")
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-shell">
      <Card className="login-card">
        <CardHeader>
          <div className="brand-mark login-mark" aria-hidden="true">
            <Aperture />
          </div>
          <CardTitle>Fallback Forge</CardTitle>
          <CardDescription>Enter the team access password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
            {error || notice ? (
              <Alert variant={error ? "destructive" : "default"}>
                <AlertCircle />
                <AlertDescription>{error || notice}</AlertDescription>
              </Alert>
            ) : null}
            <Field>
              <FieldLabel htmlFor="access-password">Password</FieldLabel>
              <Input
                id="access-password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                aria-invalid={Boolean(error) || undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={submitting || !password}>
              <LogIn data-icon="inline-start" />
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
