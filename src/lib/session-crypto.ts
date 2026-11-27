import sodium from 'libsodium-wrappers';

const PREFIX = 'auroflow.session-key.v1.';

function storageKey(owner: string, repo: string): string {
  return PREFIX + `${owner}/${repo}`.toLowerCase();
}

export async function ensureSessionKey(
  owner: string,
  repo: string
): Promise<string> {
  await sodium.ready;

  const name = storageKey(owner, repo);
  const stored = localStorage.getItem(name);

  if (stored) {
    const privateKey = sodium.from_base64(
      stored,
      sodium.base64_variants.ORIGINAL
    );

    const publicKey = sodium.crypto_scalarmult_base(privateKey);

    return sodium.to_base64(
      publicKey,
      sodium.base64_variants.ORIGINAL
    );
  }

  const pair = sodium.crypto_box_keypair();

  localStorage.setItem(
    name,
    sodium.to_base64(
      pair.privateKey,
      sodium.base64_variants.ORIGINAL
    )
  );

  return sodium.to_base64(
    pair.publicKey,
    sodium.base64_variants.ORIGINAL
  );
}

export async function decryptEndpoint(
  owner: string,
  repo: string,
  runId: number,
  encrypted: string
): Promise<string> {
  await sodium.ready;

  const stored = localStorage.getItem(storageKey(owner, repo));

  if (!stored) {
    throw new Error('Session private key unavailable.');
  }

  const privateKey = sodium.from_base64(
    stored,
    sodium.base64_variants.ORIGINAL
  );

  const publicKey = sodium.crypto_scalarmult_base(privateKey);

  const plaintext = sodium.crypto_box_seal_open(
    sodium.from_base64(
      encrypted,
      sodium.base64_variants.ORIGINAL
    ),
    publicKey,
    privateKey
  );

  const payload = JSON.parse(sodium.to_string(plaintext));

  if (
    payload.repository !== `${owner}/${repo}`.toLowerCase() ||
    String(payload.run_id) !== String(runId) ||
    typeof payload.endpoint !== 'string'
  ) {
    throw new Error('Invalid encrypted session.');
  }

  return payload.endpoint;
}
