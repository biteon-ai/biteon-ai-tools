"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";

export default function LoginPage() {
  const toast = useToast();
  const router = useRouter();
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      toast("Signed in", "success");
      router.push("/");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Login failed", "error");
    }
  }

  return (
    <form onSubmit={submit} className="card mx-auto mt-24 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <label className="block text-sm text-slate-300">Email<input className="input mt-1" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="block text-sm text-slate-300">Password<input type="password" className="input mt-1" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="btn" type="submit">Continue</button>
    </form>
  );
}
