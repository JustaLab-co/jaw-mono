import { config } from '@/connections/config';

// The key rides in the proxy URL, so an error that quotes the URL must not carry it out.
export function scrub(text: string) {
  const key = config().paymasterApiKey;
  const bare = key ? text.split(key).join('[key]').split(encodeURIComponent(key)).join('[key]') : text;
  return bare.replace(/api-key=[^&\s"']*/gi, 'api-key=[key]');
}
