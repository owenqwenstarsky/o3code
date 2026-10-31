import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The origin (`scheme://host[:port]`) at which people other than the owner reach this
 * environment, such as a guest opening a link or a webhook sender. None means the environment
 * has no such address, so guest links are unavailable and webhook URLs stay relative.
 */
export class EnvironmentPublicOrigin extends Context.Reference<{
  readonly current: Effect.Effect<Option.Option<string>>;
}>("t3/environment/EnvironmentPublicOrigin", {
  defaultValue: () => ({ current: Effect.succeedNone }),
}) {}
