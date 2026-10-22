-- Server-verified device biometric credentials.
-- The server stores public keys only; private keys remain in Android Keystore and
-- require a strong biometric for every signature. Challenges are one-use and short-lived.
CREATE TABLE IF NOT EXISTS public.account_biometric_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type text NOT NULL CHECK (account_type IN ('customer','admin')),
  subject_id uuid NOT NULL,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key_spki text NOT NULL CHECK (length(public_key_spki) BETWEEN 80 AND 4096),
  key_alias text NOT NULL UNIQUE CHECK (key_alias ~ '^[a-f0-9]{32}$'),
  device_label text NOT NULL DEFAULT 'Android device' CHECK (length(device_label) <= 120),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (account_type, subject_id)
);
CREATE INDEX IF NOT EXISTS account_biometric_credentials_auth_user_idx
  ON public.account_biometric_credentials(auth_user_id);
ALTER TABLE public.account_biometric_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_biometric_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.account_biometric_credentials TO service_role;

CREATE TABLE IF NOT EXISTS public.account_biometric_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type text NOT NULL CHECK (account_type IN ('customer','admin')),
  subject_id uuid NOT NULL,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('enroll','login')),
  challenge text NOT NULL CHECK (length(challenge) = 64),
  credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '2 minutes'),
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_biometric_challenges_expiry_idx
  ON public.account_biometric_challenges(expires_at);
ALTER TABLE public.account_biometric_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_biometric_challenges FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.account_biometric_challenges TO service_role;
)