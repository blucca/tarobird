# DeepSeek provider, model and reasoning selection

Creation, Bot settings, the composer, `/model` / `/effort`, and
`tarobot bots model` share the Host-owned DeepSeek catalog. The catalog comes
from the installed Harness CLI's public `session/modelCatalog` method. It
contains complete provider/model identities and model-specific reasoning
choices; models with the same name remain distinct.

The client treats choice IDs as opaque. Ordinary identities retain
`provider/model/path`; exceptional IDs use a namespaced percent encoding so a
slash in the provider, or a literal percent/space in an ID, cannot change the
route. Legacy bare model IDs are resolved only when unambiguous. DeepSeek IDs
may occupy up to 512 characters. Labels never contain provider failure details,
credentials, API mappings or arbitrary plugin configuration.

An empty effort follows native defaults. `off` explicitly disables reasoning
when the selected native model advertises it. Other supported public effort
names are offered only when present in that model's metadata. A model with no
reasoning metadata offers default only. Unknown native effort names are not
invented as App controls; following that model's native default remains possible.
`/effort default` clears an override; `/effort off` preserves the literal native
choice. The same distinction applies to CLI `--effort`.

Discovery uses the configured executable, environment, workspace and web
profile, copied into a disposable private DSH home. Credentials are copied for
this read, rather than linked. Only the public catalog is requested: no Session
is created and no prompt, selection or native settings write is sent. Native
startup itself may write in the disposable home. A seven-second deadline leaves
time within the existing ten-second Bot RPC. Concurrent reads coalesce; writes
request a fresh catalog, including when an earlier reader is still cleaning up.
Temporary children and homes are cleaned on success, failure and timeout.

`ready`, `no-models`, and `unavailable` distinguish a healthy catalog, no configured
models and failed discovery. Partial provider failures are unavailable even if
some displayable choices remain. A failed refresh retains saved values and the
client draft. Unavailable catalogs, deleted routes and unsupported reasoning
choices reject mutations without replacing the config. Model and effort use the
existing shared revision and file mutex, so a stale device or concurrent edit
cannot overwrite another change. An exact no-op remains safe when discovery is
unavailable. Older Hosts without catalog status retain their existing API behavior.

A ready catalog gives the follow-default choice the resolved DSH default's
provider/model identity. When DSH has concrete models but no usable default
(never set, or pointing to a removed route), that choice has no identity and the
Host refuses it. Creation, Bot settings and the composer quick menus share
`deepSeekDefaultUnavailable` to recognize this case: they disable follow-default,
say that no usable default model is set and ask for a specific model. They
neither rewrite the saved value nor pick a model for the user, and an existing
Bot can be corrected by choosing one. Once DSH reports a default again,
follow-default becomes selectable on the next catalog read. Older Hosts, other
engines and unavailable catalogs are unaffected. Effort-only settings do not
receive the model catalog and still report the Host's refusal after submission.

At each native task boundary, the adapter revalidates the exact route and effort
against native metadata and checks the native selection acknowledgement. Changed
settings are explicitly applied even if the remote follow projection is still
showing the preceding choice. Existing sessions and active turns are not reset.
Harness persists choices in each Bot's private profile; the shared profile is
never updated by Bot selection. The existing Host-start mirror refreshes that
private profile from shared native configuration. Changes to shared provider
configuration or defaults while a worker is running require its normal idle
restart; catalog refresh does not mutate a live worker's profile.

Regression coverage: `deepseek-models`, `deepseek-model-settings`,
`deepseek-native-model-settings`, `deepseek-bot-creation`, `host-cli-model`, and
`core-engine-command-rules`, plus the existing adapter/settings suites. Client
coverage lives in `deepseek-model-settings` and `composer-model-controls` browser
specs. Local native validation used DSH 0.2.2-rc.5 and two isolated Bot homes. A
metadata-only probe made zero provider requests. A separate fixed-response
loopback probe ran three native turns, checked distinct provider routes and
opaque IDs in outgoing requests, and verified native request headers for off,
no override, and restored medium. Harness also generated one local title request.
The shared profile hash stayed unchanged. These are local native/loopback checks,
not paid-provider execution or installed-device acceptance.
