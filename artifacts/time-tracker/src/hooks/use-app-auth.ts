import { useQuery } from "@tanstack/react-query";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

async function fetchAuthStatus(): Promise<boolean> {
  const res = await fetch("/api/auth/app/me", { credentials: "include" });
  return res.ok;
}

export function useAppAuth(): AuthState {
  const { data, isLoading } = useQuery<boolean>({
    queryKey: ["app-auth"],
    queryFn: fetchAuthStatus,
    retry: false,
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
    gcTime: 10 * 60 * 1000,
  });

  if (isLoading) return "loading";
  return data ? "authenticated" : "unauthenticated";
}
