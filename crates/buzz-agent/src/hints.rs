use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MAX_SKILL_BODY_BYTES: usize = 32 * 1024;
const SKILL_DIRS: &[&str] = &[".agents/skills", ".goose/skills", ".claude/skills"];

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

#[derive(Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// Absolute path to the SKILL.md file; used by `load_skill` to read on demand.
    pub path: PathBuf,
    /// Absolute paths to every non-SKILL.md file in the skill directory tree.
    /// Pre-enumerated at discovery time so `load_skill` can match by relative path
    /// without doing arbitrary filesystem lookups at call time.
    pub supporting_files: Vec<PathBuf>,
}

/// Handles both normal repos (`.git/` dir) and worktrees (`.git` file).
fn parse_skill_frontmatter(content: &str) -> Option<(String, String)> {
    // Must start with `---`
    let rest = content.strip_prefix("---\n")?;
    // Find the closing `---`
    let close_pos = rest.find("\n---")?;
    let yaml_block = &rest[..close_pos];

    let map: HashMap<String, serde_yaml::Value> = serde_yaml::from_str(yaml_block).ok()?;
    let name = map
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;
    let description = map
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    Some((name, description))
}

fn scan_skill_dir(dir: &Path, seen: &mut HashSet<String>, skills: &mut Vec<SkillEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        // Use std::fs::metadata (follows symlinks) rather than DirEntry::file_type
        // (which returns FileType::Symlink for symlinks, causing is_dir() to return
        // false even when the symlink target is a directory).
        .filter(|e| {
            std::fs::metadata(e.path())
                .map(|m| m.is_dir())
                .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    subdirs.sort();

    for subdir in subdirs {
        let skill_md = subdir.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&skill_md) else {
            continue;
        };
        let Some((name, description)) = parse_skill_frontmatter(&content) else {
            continue;
        };
        if seen.contains(&name) {
            continue;
        }
        seen.insert(name.clone());

        // Collect supporting files: every non-SKILL.md file in the skill dir tree.
        // Don't descend into subdirs that themselves have a SKILL.md — those are
        // separate skills with their own entries.
        let supporting_files = collect_supporting_files(&subdir);

        skills.push(SkillEntry {
            name,
            description,
            path: skill_md,
            supporting_files,
        });
    }
}

/// Walk `skill_dir` recursively and return the absolute path of every file
/// that is not `SKILL.md`. Subdirectories that contain their own `SKILL.md`
/// are treated as separate skills and are not descended into.
fn collect_supporting_files(skill_dir: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut visited_dirs = HashSet::new();
    collect_supporting_files_impl(skill_dir, &mut result, &mut visited_dirs);
    result.sort();
    result
}

fn collect_supporting_files_impl(
    current: &Path,
    out: &mut Vec<PathBuf>,
    visited_dirs: &mut HashSet<PathBuf>,
) {
    let Ok(canonical_current) = current.canonicalize() else {
        return;
    };
    if !visited_dirs.insert(canonical_current) {
        return;
    }

    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.path());

    for entry in items {
        let path = entry.path();
        // Use std::fs::metadata (follows symlinks) so symlinked subdirs and files
        // inside a skill directory are handled correctly.
        let ft = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if ft.is_dir() {
            // Don't descend into subdirs that are themselves skills.
            if path.join("SKILL.md").is_file() {
                continue;
            }
            collect_supporting_files_impl(&path, out, visited_dirs);
        } else if ft.is_file() && path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
            out.push(path);
        }
    }
}

fn discover_skills_impl(cwd: &Path, home: Option<&Path>) -> Vec<SkillEntry> {
    let mut seen = HashSet::new();
    let mut skills = Vec::new();

    for dir_suffix in SKILL_DIRS {
        scan_skill_dir(&cwd.join(dir_suffix), &mut seen, &mut skills);
    }

    if let Some(home) = home {
        scan_skill_dir(&home.join(".agents/skills"), &mut seen, &mut skills);
    }

    skills
}

/// Discover the skills available from `cwd`.
///
/// Hint *files* are goose's job (`PromptManager::build_system_prompt` walks
/// them from the git root). This is only the skill index, which stays ours
/// because `load_skill` is served by [`crate::builtin_client`] and needs the
/// same [`SkillEntry`] list the tool dispatches against.
pub fn discover_skills(cwd: &Path) -> Vec<SkillEntry> {
    discover_skills_impl(cwd, home_dir().as_deref())
}

/// Render the skill index for the system prompt.
///
/// Returns an empty string for an empty slate so the caller can skip the
/// extra entirely rather than adding an empty section.
pub fn skill_index(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }

    let mut out = String::from("# Available Skills\n");
    for skill in skills {
        out.push_str(&format!("- {}: {}\n", skill.name, skill.description));
    }
    // Goose namespaces platform-extension tools as `{extension}__{tool}`
    // (`extension_manager.rs:1415`), so name the tool the way the model
    // actually sees it -- otherwise the prompt advertises a tool that does
    // not exist in its tool list.
    out.push_str(&format!(
        "\nUse the `{}__{}` tool to read the full content of a skill before using it.\n",
        crate::builtin_client::BUILTIN_EXTENSION_NAME,
        crate::builtin::LOAD_SKILL_TOOL,
    ));
    out
}

/// Strip the YAML frontmatter block from a skill file's content and return
/// the body. If no valid frontmatter is found, returns the content unchanged.
pub(crate) fn strip_frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content;
    };
    let Some(close_pos) = rest.find("\n---") else {
        return content;
    };
    let after = &rest[close_pos + 4..]; // skip "\n---"
    after.strip_prefix('\n').unwrap_or(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn discover_skills_finds_across_dirs() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();

        // Skill in .agents/skills/
        let agents_skill = cwd.join(".agents/skills/my-skill");
        std::fs::create_dir_all(&agents_skill).unwrap();
        std::fs::write(
            agents_skill.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A skill\n---\nSkill body here.\n",
        )
        .unwrap();

        // Skill in .goose/skills/
        let goose_skill = cwd.join(".goose/skills/other-skill");
        std::fs::create_dir_all(&goose_skill).unwrap();
        std::fs::write(
            goose_skill.join("SKILL.md"),
            "---\nname: other-skill\ndescription: Another skill\n---\nOther body.\n",
        )
        .unwrap();

        let skills = discover_skills_impl(cwd, None);
        assert_eq!(skills.len(), 2);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"my-skill"), "missing my-skill");
        assert!(names.contains(&"other-skill"), "missing other-skill");
        // Paths should point to the SKILL.md files.
        for skill in &skills {
            assert!(skill.path.exists(), "path does not exist: {:?}", skill.path);
            assert!(skill.path.ends_with("SKILL.md"));
        }
    }

    #[test]
    fn discover_skills_dedup_by_name() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();

        // Same name in .agents/skills/ (first) and .goose/skills/ (second)
        let agents_skill = cwd.join(".agents/skills/shared");
        std::fs::create_dir_all(&agents_skill).unwrap();
        std::fs::write(
            agents_skill.join("SKILL.md"),
            "---\nname: shared\ndescription: from agents\n---\nAgents body.\n",
        )
        .unwrap();

        let goose_skill = cwd.join(".goose/skills/shared");
        std::fs::create_dir_all(&goose_skill).unwrap();
        std::fs::write(
            goose_skill.join("SKILL.md"),
            "---\nname: shared\ndescription: from goose\n---\nGoose body.\n",
        )
        .unwrap();

        let skills = discover_skills_impl(cwd, None);
        assert_eq!(skills.len(), 1, "duplicate name should be deduplicated");
        assert_eq!(
            skills[0].description, "from agents",
            "first wins (.agents/)"
        );
        // Path should point to the .agents/ version (first wins).
        assert!(skills[0]
            .path
            .to_str()
            .unwrap()
            .contains(".agents/skills/shared"));
    }

    #[test]
    fn discover_skills_skips_missing_name() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();

        let skill_dir = cwd.join(".agents/skills/no-name");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: No name here\n---\nBody.\n",
        )
        .unwrap();

        let skills = discover_skills_impl(cwd, None);
        assert!(skills.is_empty(), "entry without name should be skipped");
    }

    #[test]
    fn discover_skills_global_skills_loaded() {
        let home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        let skill_dir = home.path().join(".agents/skills/global-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: global-skill\ndescription: A global skill\n---\nGlobal body.\n",
        )
        .unwrap();
        let skills = discover_skills_impl(cwd.path(), Some(home.path()));
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "global-skill");
    }

    #[test]
    fn discover_skills_project_wins_over_global() {
        let home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();

        let project_skill = cwd.path().join(".agents/skills/shared");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            "---\nname: shared\ndescription: from project\n---\nProject body.\n",
        )
        .unwrap();

        let global_skill = home.path().join(".agents/skills/shared");
        std::fs::create_dir_all(&global_skill).unwrap();
        std::fs::write(
            global_skill.join("SKILL.md"),
            "---\nname: shared\ndescription: from global\n---\nGlobal body.\n",
        )
        .unwrap();

        let skills = discover_skills_impl(cwd.path(), Some(home.path()));
        assert_eq!(skills.len(), 1, "duplicate name should be deduplicated");
        assert_eq!(
            skills[0].description, "from project",
            "project-level should win over global"
        );
    }

    #[test]
    fn discover_skills_no_home_dir() {
        let cwd = TempDir::new().unwrap();
        let skill_dir = cwd.path().join(".agents/skills/local");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: local\ndescription: Local skill\n---\nBody.\n",
        )
        .unwrap();
        let skills = discover_skills_impl(cwd.path(), None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "local");
    }

    #[test]
    fn collect_supporting_files_finds_non_skill_md_files() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path();
        // SKILL.md should be excluded.
        std::fs::write(skill_dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        // A references subdir with files.
        let refs = skill_dir.join("references");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("foo.md"), "foo").unwrap();
        std::fs::write(refs.join("bar.md"), "bar").unwrap();
        // A script at the top level.
        std::fs::write(skill_dir.join("setup.sh"), "#!/bin/sh").unwrap();

        let files = collect_supporting_files(skill_dir);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.contains(&"foo.md".to_owned()),
            "missing foo.md: {names:?}"
        );
        assert!(
            names.contains(&"bar.md".to_owned()),
            "missing bar.md: {names:?}"
        );
        assert!(
            names.contains(&"setup.sh".to_owned()),
            "missing setup.sh: {names:?}"
        );
        assert!(
            !names.contains(&"SKILL.md".to_owned()),
            "SKILL.md should be excluded: {names:?}"
        );
    }

    #[test]
    fn collect_supporting_files_does_not_descend_into_nested_skills() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path();
        std::fs::write(skill_dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        std::fs::write(skill_dir.join("helper.sh"), "#!/bin/sh").unwrap();

        // A nested subdir that is itself a skill — should not be descended into.
        let nested = skill_dir.join("nested-skill");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("SKILL.md"), "---\nname: nested\n---\n").unwrap();
        std::fs::write(nested.join("secret.md"), "should not appear").unwrap();

        let files = collect_supporting_files(skill_dir);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.contains(&"helper.sh".to_owned()),
            "missing helper.sh: {names:?}"
        );
        assert!(
            !names.contains(&"secret.md".to_owned()),
            "nested skill's files should not appear: {names:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn collect_supporting_files_skips_symlink_cycles() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path();
        std::fs::write(skill_dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();

        let refs = skill_dir.join("references");
        std::fs::create_dir_all(&refs).unwrap();
        let guide = refs.join("guide.md");
        std::fs::write(&guide, "guide").unwrap();
        std::os::unix::fs::symlink(&refs, refs.join("loop")).unwrap();

        let files = collect_supporting_files(skill_dir);
        assert_eq!(files, vec![guide]);
    }

    #[test]
    fn discover_skills_populates_supporting_files() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let skill_dir = cwd.join(".agents/skills/with-refs");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: with-refs\ndescription: Has refs\n---\nBody.\n",
        )
        .unwrap();
        let refs = skill_dir.join("references");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("guide.md"), "guide content").unwrap();

        let skills = discover_skills_impl(cwd, None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "with-refs");
        assert_eq!(skills[0].supporting_files.len(), 1);
        assert!(
            skills[0].supporting_files[0].ends_with("references/guide.md"),
            "unexpected path: {:?}",
            skills[0].supporting_files[0]
        );
    }

    /// The bug this module's shrink was for: buzz-agent used to add its own
    /// hint-file scan as a prompt extra, while goose's `build_system_prompt`
    /// was already loading the same files. Every hint landed in the system
    /// prompt twice. Nothing here may reintroduce hint *file* loading -- that
    /// is goose's job now.
    ///
    /// The banned names are assembled at runtime so this guard does not trip
    /// over its own source text.
    #[test]
    fn this_module_does_not_load_hint_files() {
        let source = include_str!("hints.rs");
        for banned in [format!("AGENTS{}md", "."), format!(".goose{}", "hints")] {
            assert!(
                !source.contains(&banned),
                "hints.rs references {banned}: hint-file loading belongs to \
                 goose's PromptManager, or hints render twice in the prompt"
            );
        }
    }

    #[test]
    fn the_skill_index_is_empty_for_an_empty_slate() {
        // An empty section would still be added as a prompt extra, spending
        // tokens on a header with nothing under it.
        assert!(skill_index(&[]).is_empty());
    }

    #[test]
    fn the_skill_index_names_the_tool_as_the_model_sees_it() {
        let skills = vec![SkillEntry {
            name: "widget".to_string(),
            description: "makes widgets".to_string(),
            path: PathBuf::from("/tmp/widget/SKILL.md"),
            supporting_files: Vec::new(),
        }];
        let index = skill_index(&skills);
        assert!(index.contains("- widget: makes widgets"));
        // Namespaced, because goose advertises platform tools as
        // `{extension}__{tool}`; the bare name is not in the model's tool list.
        assert!(index.contains("buzz__load_skill"));
    }
}
