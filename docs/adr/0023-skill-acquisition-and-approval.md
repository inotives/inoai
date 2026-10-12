# Separate skill acquisition from approval

Skill management will use `npx skills add` or an equivalent owner-invoked
source command to acquire a package into one deployed Agent Instance's runtime
home, while keeping enablement as a separate explicit owner approval step. This
preserves the existing trust boundary: downloading a package makes it
inspectable, but only approval can expose it to an Agent Runtime.

Acquired packages use the existing `<runtime-home>/skills/<skill-id>/` layout;
provider-specific directories and symlinks are not runtime-home storage.

When an upstream package has no `skill.yaml`, acquisition creates the manifest
inside that deployed package. The generated manifest is conservative and the
package remains disabled until the owner reviews and approves it.

Generated manifests default all declared capabilities to `none`; owners may
edit the manifest before approval when a package has a justified requirement.

The package records its non-secret Skill Source in the same `skill.yaml`
manifest. `skills-enabled.json` remains the approval record. This lets
`update` repeat the original acquisition without turning source metadata into
trust; any source or manifest change changes the package hash and requires
reapproval.

The published CLI targets an Agent Instance by name and resolves `--agent
<name>` to `.inoai-connect-<name>` in the deployment folder. The unnamed
default remains `.inoai-connect`; explicit `--connect-dir` supports legacy and
test homes.

Acquisition, update, removal, and approval remain local owner operations. They
are not exposed as chat-turn actions or delegated to the Agent Runtime.

Remote updates are transactional: stage and validate the replacement first;
on failure, preserve the currently installed package and its approval.
