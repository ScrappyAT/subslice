/**
 * The one date-formatting function every view page uses. Period
 * boundaries are stored as instants (UTC), and this reads them back in
 * UTC explicitly — the same reasoning lib/period.ts gives for doing all of
 * its arithmetic in UTC: a date rendered in whatever timezone the server
 * happens to run in would show a different day than the one the period
 * math actually computed.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}
