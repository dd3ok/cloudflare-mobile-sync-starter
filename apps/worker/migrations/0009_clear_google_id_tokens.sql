-- Earlier native sign-ins could retain the Google ID token on account creation.
UPDATE account SET idToken = NULL
WHERE providerId = 'google' AND idToken IS NOT NULL;
