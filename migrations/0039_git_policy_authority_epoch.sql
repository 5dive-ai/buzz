-- Kind 30617 is live Git authorization policy. Its replacement or deletion
-- must advance the independently witnessed PostgreSQL authority vector so a
-- stale restore cannot revive an earlier, more permissive policy.

CREATE TRIGGER git_policy_insert_authority_epoch
    AFTER INSERT ON events
    FOR EACH ROW WHEN (NEW.kind = 30617)
    EXECUTE FUNCTION advance_authorization_authority_epoch();

CREATE TRIGGER git_policy_update_authority_epoch
    AFTER UPDATE ON events
    FOR EACH ROW WHEN (OLD.kind = 30617 OR NEW.kind = 30617)
    EXECUTE FUNCTION advance_authorization_authority_epoch();

CREATE TRIGGER git_policy_delete_authority_epoch
    AFTER DELETE ON events
    FOR EACH ROW WHEN (OLD.kind = 30617)
    EXECUTE FUNCTION advance_authorization_authority_epoch();
