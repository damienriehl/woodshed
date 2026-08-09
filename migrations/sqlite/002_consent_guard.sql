CREATE TRIGGER participation_consent_non_broadening
BEFORE UPDATE OF consent_scope ON guest_participations
WHEN OLD.consent_scope = 'event' AND NEW.consent_scope <> 'event'
BEGIN SELECT RAISE(ABORT, 'consent cannot be broadened implicitly'); END;
