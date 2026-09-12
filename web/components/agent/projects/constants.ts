// Shared between the dialog's `maxLength` and the route's validator, for the same reason colors.ts
// is shared: a limit the form does not enforce is a 400 the user meets after typing, and a limit
// only the form enforces is not a limit at all.
//
// There is no constraint on `hermes_projects.name` in the database — this is the only thing between
// a name and a group header that is a paragraph.
export const MAX_PROJECT_NAME = 80;
