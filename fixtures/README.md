# Fixtures

`2026-07-25-changeover.csv` is a **synthetic stand-in** for the real Saturday
July 25 export described in section 4 of the build spec. The real file was not in
this folder, so this one was written to reproduce every quirk the spec names,
at the same scale:

- 34 jobs, the same column set (Date, Customer, First Name, Last Name, Address,
  Description, Notes)
- windows in every format listed: `9-4`, `10-3`, `10am-4pm`, `10-3pm Time Frame`,
  `(10-3)`, `11-4`
- the two Excel-mangled windows: `3-Oct` (meaning 10-3) and `4-Oct` (meaning 10-4)
- five time locks (`11:30am please keep at this time`, `Keep 7/25 at 10am`, …)
- access info in each of its shapes: `Key - 1066`, `Lockbox - 2887`,
  `door code 1313`, key pickup from a person, keys under a rock and a deck post
- special instructions: fridge cleanouts, laundry transfers, coffee restocking,
  "was not happy last time", a request for a named cleaner
- 2 jobs with no notes at all
- notes that repeat the same code or window two or three times
- inconsistent Description spellings: "Change Over", "Changeover",
  "Cleaning - Change Over", plus "House Cleaning" and "Linens"
- geography matching the real operation: Wellfleet dominant, a seven-job Truro
  cluster, and Chatham/Eastham outliers

**Every name, address and access code here is invented.** Street names are real
Cape Cod streets, but the house numbers, customers and codes are not.

The optimizer tests in `tests/` run against this file. When the real export
arrives, drop it in beside this one and point `tests/optimizer.test.ts` at it —
the assertions (Truro stays together, Chatham is not stranded, every window is
respected, pinned jobs land on their time) are written against properties of the
schedule rather than specific job ids, so they should carry over unchanged.
