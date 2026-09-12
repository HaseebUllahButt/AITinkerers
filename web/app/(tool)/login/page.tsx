import { devSignInEnabled, googleSignInEnabled } from "@auth";
import LoginForm from "./LoginForm";

// Server component on purpose. Which providers exist is known at render time,
// so the correct button is in the FIRST paint — probing from the client showed
// a Google button that could not work until getProviders() came back.
export default function LoginPage() {
  return <LoginForm devEnabled={devSignInEnabled} googleEnabled={googleSignInEnabled} />;
}
