# MainSequence organization projects

Desktop clients distinguish repositories from `OrganizationProject` records.
Each project belongs to one environment and groups specific repository branches.
A repository can contribute multiple branches; a branch can appear in many projects.

## Public client and actions

`OrganizationProjectClient(session, backend, signal)` uses the existing human-session
API. `environments()` reads all environment pages. `list(environmentUid,
{search, limit, offset})` returns a project page. `getProject(environmentUid,
projectUid)` loads its detail and full member branches on demand. Responses are
validated for exact project, branch and environment identity. Reads do not depend
on global repository visibility: a shared branch can be visible when its parent
repository and sibling branches are inaccessible.

`createDevTools().dispatch()` accepts the host actions `organization-environments`,
`organization-projects`, `organization-project`, `organization-project-link` and
`organization-project-setup`. They are separate from `createProjectOperations`,
whose backward-compatible API still handles local repository operations. No new
backend route, schema or grant is introduced; runtime/workload credentials remain
outside the human Project API.

Links revalidate membership and use Command Center URLs when the host supplies
`commandCenterUrl`. Otherwise repository/branch links use the authorized GitHub
binding. Missing/inaccessible bindings are reported, not guessed. Only HTTP(S)
URLs without credentials are opened.

## Local workspace

`organization-project-setup` takes `backend`, `environmentUid`, `projectUid` and
an absolute `baseDir`. After preflight it:

1. Prepares missing repositories in the existing
   `<base>/<organization>/projects/<repository-name>-<uid>` layout. Existing source
   checkouts keep their branch and edits.
2. Creates or reuses a UID-scoped storage container below
   `<base>/<organization>/organization-projects/<backend-hash>/`. The folder opened
   in Claude is a child named exactly after the project, including case and spaces:
   `Ontology`, never `ontology-<uid>`. Identity remains in the parent and manifests.
3. Prepares independent branch checkouts beneath the container's `repositories/`,
   alongside the named workspace. Cloning uses
   `--reference-if-able --dissociate` to reuse local objects without sharing mutable
   branch state. It verifies the origin and attached branch for every membership.

Existing dirty checkouts on the assigned branch are reused. A branch switch with
uncommitted changes is refused. The service never resets, stashes, deletes, pulls,
force-checks-out or installs dependencies automatically. Removed memberships leave
their folders intact. Existing `CLAUDE.md` is preserved. New instructions point to
the manifest. Repository `.env` files contain only the backend endpoint, following
the existing SSH/deploy-key setup policy. No Claude credentials are accessed.

Workspace and Git locks serialize mutations. Redirected directories, unmanaged
nonempty workspace folders and wrong repository origins are refused. Failures and
cancellation report partial effects; completed checkouts are retained for retry.
The schema 2 manifest remains `preparing` until every branch is verified, then
becomes `ready`. This means the checkouts are prepared, not that a Claude session
has attached them. Existing schema 1 containers reuse their repository paths and
copy their instructions into the named child without moving or recloning repos.
Project renames rename the child workspace while retaining checkout paths.

The result includes a local root and `claude://code/new?folder=...` link. Claude's
host adapter uses `readOrganizationProjectWorkspace` to validate both manifests
and every managed checkout, then verifies the current branch before opening.
The plugin remembers the exact user-selected membership in its own store. On
startup in that exact folder it revalidates the selection and invokes the native
`/add-dir` command once for every checkout. It reports attachment only after each
command confirms registration; failure is visible and retry retains completed
attachments. Changed memberships require another setup. Other sessions are untouched.
Claude owns folder trust and conversation creation. Reusing a workspace does not
overwrite a chat; local commands need no model turn and private Claude storage is
never edited. The host plugin must be enabled for automatic attachment.

## Verification

`tests/organization-projects.test.cjs` covers pagination, membership, links,
branch-only visibility, real temporary Git checkouts, repeat setup, clean/dirty
switching, two distinct repositories on `main`, exact names, legacy migration,
wrong origins, redirected directories and cancellation. Remote API and
SSH responses use fixtures, without a person's session or repositories.
