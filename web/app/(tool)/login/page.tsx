import LoginForm from "./LoginForm";

// One provider, always available — see auth.ts. Nothing to decide at render
// time any more, so this stays a thin server component.
export default function LoginPage() {
  return <LoginForm />;
}
