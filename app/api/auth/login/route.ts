import { NextResponse } from "next/server";

import {
  checkPassword,
  createSessionToken,
  isPasswordConfigured,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD and SESSION_SECRET are not set on the server." },
      { status: 500 },
    );
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!checkPassword(password)) {
    // Deliberately vague: this is the only thing standing between the internet
    // and a list of door codes.
    return NextResponse.json({ error: "That password is not right." }, { status: 401 });
  }

  const token = createSessionToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token.value, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: token.maxAge,
  });
  return response;
}
