// Intentionally exports nothing: the scan must warn and continue past this
// file rather than abandoning the rest of the scan. See the F5 regression test
// in tests/scan.test.ts ("should keep scanning after an export-less module").
export {};
