import copy

import pytest
import yaml

from harbor_buzz_orchestra import ExperimentManifest, ManifestError


def test_hash_is_independent_of_mapping_and_yaml_key_order(tmp_path, manifest_data):
    first = ExperimentManifest.load(manifest_data)
    path = tmp_path / "manifest.yaml"
    path.write_text(
        yaml.safe_dump(
            dict(reversed(list(copy.deepcopy(manifest_data).items()))), sort_keys=False
        )
    )
    second = ExperimentManifest.load(path)
    assert first.canonical_bytes() == second.canonical_bytes()
    assert first.sha256 == second.sha256
    assert len(first.sha256) == 64


def test_hash_changes_when_staffing_changes(manifest_data):
    first = ExperimentManifest.load(manifest_data)
    changed = copy.deepcopy(manifest_data)
    changed["roster"][1]["count"] = 3
    assert ExperimentManifest.load(changed).sha256 != first.sha256


def test_todo_enforcement_defaults_off_and_changes_condition_identity(manifest_data):
    control = ExperimentManifest.load(manifest_data)
    assert control.todo_enforcement is False
    treatment = ExperimentManifest.load({**manifest_data, "todo_enforcement": True})
    assert treatment.todo_enforcement is True
    # The flag is part of the condition, so the two arms hash differently.
    assert treatment.sha256 != control.sha256


@pytest.mark.parametrize(
    ("mutation", "match"),
    [
        (lambda data: data.update({"unknown": True}), "Extra inputs"),
        (lambda data: data["roster"].pop(0), "exactly one orchestrator"),
        (lambda data: data["prices"].pop("databricks/qwen"), "prices missing"),
        (lambda data: data["roster"][1].update({"concurrency": 5}), "concurrency"),
    ],
)
def test_invalid_manifest_is_rejected(manifest_data, mutation, match):
    mutation(manifest_data)
    with pytest.raises(ManifestError, match=match):
        ExperimentManifest.load(manifest_data)


def test_non_mapping_document_is_rejected(tmp_path):
    path = tmp_path / "manifest.yaml"
    path.write_text("- not\n- a\n- mapping\n")
    with pytest.raises(ManifestError, match="root must be a mapping"):
        ExperimentManifest.load(path)
