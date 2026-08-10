INSERT INTO event_choice_config(event_id) SELECT id FROM events WHERE NOT EXISTS (SELECT 1 FROM event_choice_config config WHERE config.event_id = events.id);
CREATE TRIGGER event_choice_config_seed AFTER INSERT ON events BEGIN INSERT INTO event_choice_config(event_id) VALUES (NEW.id); END;
CREATE INDEX guest_participations_active_event_idx ON guest_participations(event_id) WHERE revoked_at IS NULL;
CREATE INDEX choice_proposals_event_participation_idx ON choice_proposals(event_id,participation_id);
