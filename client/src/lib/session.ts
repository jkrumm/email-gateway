// Session endpoints live on the server under /app (not /api): the login route
// sets the signed HttpOnly session cookie the /api door also accepts for
// same-origin browser requests.

export interface Session {
  authenticated: boolean;
}

export async function fetchSession(): Promise<Session> {
  const response = await fetch("/app/session", {
    credentials: "same-origin",
  });
  if (!response.ok) return { authenticated: false };
  return (await response.json()) as Session;
}

export async function login(password: string): Promise<void> {
  const response = await fetch("/app/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 ? "Wrong password" : "Login failed",
    );
  }
}

export async function logout(): Promise<void> {
  await fetch("/app/logout", {
    method: "POST",
    credentials: "same-origin",
  });
}
