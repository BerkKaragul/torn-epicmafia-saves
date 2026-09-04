import { redirect } from "next/navigation";

// The Schedule feature is currently disabled. The route, its API, and the
// availability data are all left intact — re-enable by restoring the panel
// render below and the "Schedule" tab in Nav.tsx.
export default async function SchedulePage() {
  redirect("/");
}
