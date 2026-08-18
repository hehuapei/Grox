//! Provider profile persistence and recovery domain.
//!
//! This module owns the persisted profile schema and all decisions about which
//! profile may represent the managed provider environment. Filesystem limits,
//! atomic publication, endpoint policy, and secret storage are injected by the
//! host so this domain does not depend on `main.rs` orchestration.

use std::{collections::BTreeMap, fs, path::Path};

use serde::{Deserialize, Serialize};

pub(crate) const GROX_PROVIDER_KIND_KEY: &str = "GROX_PROVIDER_KIND";
pub(crate) const GROX_PROVIDER_PROFILE_ID_KEY: &str = "GROX_PROVIDER_PROFILE_ID";
pub(crate) const GROK_MODELS_BASE_URL_KEY: &str = "GROK_MODELS_BASE_URL";
pub(crate) const SECRET_REF_DIRECT_COMPATIBLE: &str = "provider:direct-compatible";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderApiBackend {
    #[default]
    Auto,
    Responses,
    ChatCompletions,
}

impl ProviderApiBackend {
    pub(crate) fn config_value(self, _provider_name: &str, _base_url: &str) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat_completions",
            // A provider name is not protocol evidence. Compatible services use
            // Chat Completions unless the user explicitly selects Responses.
            Self::Auto => "chat_completions",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredProviderProfile {
    id: String,
    name: String,
    /// v0.3.1 and earlier stored a plaintext key in the profile. It is read for
    /// migration only and is never serialized again.
    #[serde(default, rename = "apiKey", skip_serializing)]
    legacy_api_key: Option<String>,
    base_url: String,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default)]
    api_backend: ProviderApiBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default)]
    available_models: Vec<String>,
    #[serde(default)]
    resident_models: Vec<String>,
}

impl StoredProviderProfile {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn allow_insecure_http(&self) -> bool {
        self.allow_insecure_http
    }

    pub(crate) fn api_backend(&self) -> ProviderApiBackend {
        self.api_backend
    }

    pub(crate) fn compatible_backend_model_ids(&self) -> Vec<String> {
        let mut models = self.resident_models.clone();
        if models.is_empty() {
            if let Some(model) = self.model.as_ref() {
                models.push(model.clone());
            } else if let Some(model) = self.available_models.first() {
                models.push(model.clone());
            }
        }
        canonicalize_resident_models(&mut models, &self.available_models);
        // Grok Build 0.2.x still uses grok-4.5 for session-title generation.
        if !models.iter().any(|model| model == "grok-4.5") {
            models.push("grok-4.5".to_string());
        }
        models
    }

    fn matches_managed_endpoint<Normalize>(
        &self,
        id: &str,
        base_url: &str,
        normalize_endpoint: &Normalize,
    ) -> bool
    where
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        self.id == id
            && endpoints_match(
                self,
                base_url,
                normalize_endpoint,
            )
    }

    fn summary<F, SecretBackend>(
        &self,
        secret_state: &mut F,
    ) -> Result<ProviderProfileSummary<SecretBackend>, String>
    where
        F: FnMut(&str, Option<&str>) -> Result<(SecretBackend, bool), String>,
    {
        let mut resident_models = self.resident_models.clone();
        if resident_models.is_empty() {
            if let Some(model) = self.model.as_ref().filter(|model| !model.is_empty()) {
                resident_models.push(model.clone());
            }
        }
        canonicalize_resident_models(&mut resident_models, &self.available_models);
        let (backend, has_api_key) = secret_state(
            &provider_profile_secret_ref(&self.id),
            self.legacy_api_key.as_deref(),
        )?;
        Ok(ProviderProfileSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            // Never expose a raw key to the WebView.
            api_key: String::new(),
            has_api_key,
            secret_backend: backend,
            base_url: self.base_url.clone(),
            allow_insecure_http: self.allow_insecure_http,
            api_backend: self.api_backend,
            available_models: self.available_models.clone(),
            resident_models,
        })
    }
}

pub(crate) struct ProviderProfileUpdate {
    id: String,
    name: String,
    base_url: String,
    allow_insecure_http: bool,
    api_backend: ProviderApiBackend,
    resident_models: Vec<String>,
}

impl ProviderProfileUpdate {
    pub(crate) fn new(
        id: String,
        name: String,
        base_url: String,
        api_backend: ProviderApiBackend,
    ) -> Self {
        Self {
            id,
            name,
            base_url,
            allow_insecure_http: false,
            api_backend,
            resident_models: Vec::new(),
        }
    }

    pub(crate) fn allow_insecure_http(mut self, allow: bool) -> Self {
        self.allow_insecure_http = allow;
        self
    }

    pub(crate) fn resident_models(mut self, models: Vec<String>) -> Self {
        self.resident_models = models;
        self
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderProfilesFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_id: Option<String>,
    #[serde(default)]
    profiles: Vec<StoredProviderProfile>,
}

impl ProviderProfilesFile {
    /// Read the primary profile file or, only when it is absent, recover a
    /// current-schema copy whose profile id and normalized endpoint exactly
    /// match the currently managed compatible-provider metadata.
    pub(crate) fn read_with_recovery<Read, Create, Normalize>(
        path: &Path,
        managed: &BTreeMap<String, String>,
        read_text: Read,
        atomic_create: Create,
        normalize_endpoint: Normalize,
    ) -> Result<Self, String>
    where
        Read: Fn(&Path) -> Result<String, String>,
        Create: Fn(&Path, &str) -> Result<bool, String>,
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        if path.exists() {
            return parse_profiles(path, &read_text);
        }
        let Some(identity) = ProviderRecoveryIdentity::from_managed(managed) else {
            return Ok(Self::default());
        };
        let Some(parent) = path.parent() else {
            return Ok(Self::default());
        };
        let mut backups = match fs::read_dir(parent) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name();
                    let name = name.to_str()?;
                    if !name.starts_with("grox-providers.corrupt-") || !name.ends_with(".bak") {
                        return None;
                    }
                    let modified = entry.metadata().ok()?.modified().ok()?;
                    Some((modified, entry.path()))
                })
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(format!(
                    "无法扫描供应商档案恢复副本 {}：{error}",
                    parent.display()
                ))
            }
        };
        backups.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        for (_, backup) in backups {
            let Ok(content) = read_text(&backup) else {
                continue;
            };
            let Ok(profiles) = serde_json::from_str::<Self>(&content) else {
                continue;
            };
            if profiles
                .profiles
                .iter()
                .any(|profile| profile.legacy_api_key.is_some())
                || !profiles.profiles.iter().any(|profile| {
                    profile_matches_recovery_identity(profile, &identity, &normalize_endpoint)
                })
            {
                continue;
            }
            // Only publish a current-schema serialization. A backup containing
            // legacy plaintext is rejected before even creating a temp file.
            let recovered = profiles
                .to_pretty_json()
                .map_err(|error| format!("无法序列化供应商档案恢复副本：{error}"))?;
            if !atomic_create(path, &recovered)? {
                return parse_profiles(path, &read_text);
            }
            tracing::warn!(
                target: "grox::providers",
                backup = %backup.display(),
                primary = %path.display(),
                "restored missing provider profiles from a valid recovery copy"
            );
            return Ok(profiles);
        }
        Ok(Self::default())
    }

    pub(crate) fn to_pretty_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub(crate) fn profile(&self, id: &str) -> Option<&StoredProviderProfile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    pub(crate) fn upsert_profile<Normalize>(
        &mut self,
        mut update: ProviderProfileUpdate,
        secret_changed: bool,
        normalize_endpoint: Normalize,
    )
    where
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        let available_models = self
            .profile(&update.id)
            .filter(|profile| {
                !secret_changed
                    && endpoints_match(profile, &update.base_url, &normalize_endpoint)
            })
            .map(|profile| profile.available_models.clone())
            .unwrap_or_default();
        canonicalize_resident_models(&mut update.resident_models, &available_models);
        let profile = StoredProviderProfile {
            id: update.id.clone(),
            name: update.name,
            legacy_api_key: None,
            base_url: update.base_url,
            allow_insecure_http: update.allow_insecure_http,
            api_backend: update.api_backend,
            models_url: None,
            model: update.resident_models.first().cloned(),
            available_models,
            resident_models: update.resident_models,
        };
        if let Some(index) = self.profiles.iter().position(|entry| entry.id == update.id) {
            self.profiles[index] = profile;
        } else {
            self.profiles.push(profile);
        }
    }

    pub(crate) fn update_catalog(&mut self, id: &str, models: Vec<String>) -> Result<(), ()> {
        let Some(profile) = self.profiles.iter_mut().find(|profile| profile.id == id) else {
            return Err(());
        };
        profile.available_models = models;
        canonicalize_resident_models(&mut profile.resident_models, &profile.available_models);
        if profile.resident_models.is_empty() {
            if let Some(model) = profile.available_models.first() {
                profile.resident_models.push(model.clone());
            }
        }
        profile.model = profile.resident_models.first().cloned();
        Ok(())
    }

    pub(crate) fn remove_profile(&mut self, id: &str) -> Option<StoredProviderProfile> {
        let index = self.profiles.iter().position(|profile| profile.id == id)?;
        let profile = self.profiles.remove(index);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
        }
        Some(profile)
    }

    pub(crate) fn summaries<F, SecretBackend>(
        &self,
        mut secret_state: F,
    ) -> Result<Vec<ProviderProfileSummary<SecretBackend>>, String>
    where
        F: FnMut(&str, Option<&str>) -> Result<(SecretBackend, bool), String>,
    {
        self.profiles
            .iter()
            .map(|profile| profile.summary(&mut secret_state))
            .collect()
    }

    pub(crate) fn summary<F, SecretBackend>(
        &self,
        id: &str,
        mut secret_state: F,
    ) -> Result<ProviderProfileSummary<SecretBackend>, String>
    where
        F: FnMut(&str, Option<&str>) -> Result<(SecretBackend, bool), String>,
    {
        self.profile(id)
            .ok_or_else(|| "供应商档案不存在".to_string())?
            .summary(&mut secret_state)
    }

    pub(crate) fn profile_for_managed_values<Normalize>(
        &self,
        managed: &BTreeMap<String, String>,
        normalize_endpoint: Normalize,
    ) -> Option<&StoredProviderProfile>
    where
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        let base = managed.get(GROK_MODELS_BASE_URL_KEY)?;
        // v0.3.2 records the profile reference beside endpoint metadata. The
        // legacy activeId is consulted only for marker-less v0.3.1 metadata.
        let id = managed
            .get(GROX_PROVIDER_PROFILE_ID_KEY)
            .map(String::as_str)
            .or_else(|| {
                (!managed.contains_key(GROX_PROVIDER_KIND_KEY))
                    .then_some(self.active_id.as_deref())
                    .flatten()
            })?;
        self.profiles.iter().find(|profile| {
            profile.matches_managed_endpoint(id, base, &normalize_endpoint)
        })
    }

    pub(crate) fn compatible_secret_reference<Normalize>(
        &self,
        managed: &BTreeMap<String, String>,
        normalize_endpoint: Normalize,
    ) -> Result<String, String>
    where
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        if let Some(profile) = self.profile_for_managed_values(managed, normalize_endpoint) {
            return Ok(provider_profile_secret_ref(&profile.id));
        }
        if let Some(id) = managed.get(GROX_PROVIDER_PROFILE_ID_KEY) {
            return Err(format!(
                "活动供应商档案 {id} 不存在，或服务地址与活动元数据不一致"
            ));
        }
        Ok(SECRET_REF_DIRECT_COMPATIBLE.to_string())
    }

    pub(crate) fn take_legacy_secrets(&mut self) -> Vec<(String, String)> {
        let mut secrets = Vec::new();
        for profile in &mut self.profiles {
            let Some(key) = profile
                .legacy_api_key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
            else {
                profile.legacy_api_key = None;
                continue;
            };
            secrets.push((profile.id.clone(), key.to_string()));
            profile.legacy_api_key = None;
        }
        secrets
    }

    pub(crate) fn legacy_active_profile_for_endpoint<Normalize>(
        &self,
        base_url: &str,
        normalize_endpoint: Normalize,
    ) -> Option<&StoredProviderProfile>
    where
        Normalize: Fn(&str, bool) -> Result<String, String>,
    {
        let id = self.active_id.as_deref()?;
        self.profiles.iter().find(|profile| {
            profile.matches_managed_endpoint(id, base_url, &normalize_endpoint)
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderProfileSummary<SecretBackend> {
    id: String,
    name: String,
    api_key: String,
    has_api_key: bool,
    secret_backend: SecretBackend,
    base_url: String,
    allow_insecure_http: bool,
    api_backend: ProviderApiBackend,
    available_models: Vec<String>,
    resident_models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderRecoveryIdentity {
    id: String,
    base_url: String,
}

impl ProviderRecoveryIdentity {
    fn from_managed(managed: &BTreeMap<String, String>) -> Option<Self> {
        if managed.get(GROX_PROVIDER_KIND_KEY).map(String::as_str) != Some("compatible") {
            return None;
        }
        let id = managed.get(GROX_PROVIDER_PROFILE_ID_KEY)?.trim();
        let base_url = managed.get(GROK_MODELS_BASE_URL_KEY)?.trim();
        if id.is_empty() || base_url.is_empty() {
            return None;
        }
        Some(Self {
            id: id.to_string(),
            base_url: base_url.to_string(),
        })
    }
}

pub(crate) fn provider_profile_secret_ref(id: &str) -> String {
    format!("provider:{id}")
}

pub(crate) fn checked_model_ids(models: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for model in models {
        let model = model.trim();
        if model.is_empty() {
            continue;
        }
        if model.chars().count() > 200 || model.chars().any(char::is_control) {
            return Err("模型 ID 不能超过 200 个字符或包含控制字符".into());
        }
        if !result.iter().any(|existing| existing == model) {
            result.push(model.to_owned());
        }
        if result.len() > 200 {
            return Err("常驻模型不能超过 200 个".into());
        }
    }
    Ok(result)
}

fn parse_profiles<Read>(path: &Path, read_text: &Read) -> Result<ProviderProfilesFile, String>
where
    Read: Fn(&Path) -> Result<String, String>,
{
    let content = read_text(path)?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "无法解析供应商档案 {}，已保留原文件且拒绝覆盖：{error}",
            path.display()
        )
    })
}

fn endpoints_match<Normalize>(
    profile: &StoredProviderProfile,
    candidate: &str,
    normalize_endpoint: &Normalize,
) -> bool
where
    Normalize: Fn(&str, bool) -> Result<String, String>,
{
    let Ok(profile_base) = normalize_endpoint(&profile.base_url, profile.allow_insecure_http)
    else {
        return false;
    };
    let Ok(candidate_base) = normalize_endpoint(candidate, profile.allow_insecure_http) else {
        return false;
    };
    profile_base == candidate_base
}

fn profile_matches_recovery_identity<Normalize>(
    profile: &StoredProviderProfile,
    identity: &ProviderRecoveryIdentity,
    normalize_endpoint: &Normalize,
) -> bool
where
    Normalize: Fn(&str, bool) -> Result<String, String>,
{
    profile.id == identity.id && endpoints_match(profile, &identity.base_url, normalize_endpoint)
}

fn canonical_model_id(model: &str, available_models: &[String]) -> String {
    available_models
        .iter()
        .find(|available| available.eq_ignore_ascii_case(model))
        .cloned()
        .unwrap_or_else(|| model.to_string())
}

fn canonicalize_resident_models(resident_models: &mut Vec<String>, available_models: &[String]) {
    let mut canonical = Vec::new();
    for model in resident_models.drain(..) {
        let model = canonical_model_id(model.trim(), available_models);
        if !model.is_empty() && !canonical.iter().any(|existing: &String| existing == &model) {
            canonical.push(model);
        }
    }
    *resident_models = canonical;
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        io::Write as _,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, AtomicUsize, Ordering},
        time::Duration,
    };

    use super::*;

    fn test_root(label: &str) -> PathBuf {
        static NONCE: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "grox-provider-recovery-{label}-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn test_profile(id: &str, base_url: &str) -> StoredProviderProfile {
        StoredProviderProfile {
            id: id.into(),
            name: id.into(),
            legacy_api_key: None,
            base_url: base_url.into(),
            allow_insecure_http: false,
            api_backend: ProviderApiBackend::Auto,
            models_url: None,
            model: None,
            available_models: Vec::new(),
            resident_models: Vec::new(),
        }
    }

    fn write_profiles(path: &Path, id: &str, base_url: &str) {
        let value = ProviderProfilesFile {
            active_id: Some(id.into()),
            profiles: vec![test_profile(id, base_url)],
        };
        fs::write(path, value.to_pretty_json().unwrap()).unwrap();
    }

    fn managed(id: &str, base_url: &str) -> BTreeMap<String, String> {
        BTreeMap::from([
            (GROX_PROVIDER_KIND_KEY.into(), "compatible".into()),
            (GROX_PROVIDER_PROFILE_ID_KEY.into(), id.into()),
            (GROK_MODELS_BASE_URL_KEY.into(), base_url.into()),
        ])
    }

    fn read_text(path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|error| error.to_string())
    }

    fn create_private(path: &Path, content: &str) -> Result<bool, String> {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut file) => file
                .write_all(content.as_bytes())
                .map(|()| true)
                .map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    fn normalize(value: &str, _allow_insecure_http: bool) -> Result<String, String> {
        Ok(value.trim_end_matches('/').to_string())
    }

    #[test]
    fn profiles_never_serialize_legacy_plaintext_keys() {
        let mut profile = test_profile("provider-test", "https://gateway.example.com/v1");
        profile.legacy_api_key = Some("must-not-leak".into());
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("must-not-leak"));
    }

    #[test]
    fn missing_primary_restores_latest_matching_valid_backup() {
        let root = test_root("latest");
        let primary = root.join("grox-providers.json");
        let older = root.join("grox-providers.corrupt-100.bak");
        let newer = root.join("grox-providers.corrupt-200.bak");
        write_profiles(&older, "provider-older", "https://older.example/v1");
        std::thread::sleep(Duration::from_millis(1_100));
        write_profiles(&newer, "provider-newer", "https://newer.example/v1");

        let recovered = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-newer", "https://newer.example/v1/"),
            read_text,
            create_private,
            normalize,
        )
        .unwrap();

        assert_eq!(recovered.active_id.as_deref(), Some("provider-newer"));
        assert_eq!(
            parse_profiles(&primary, &read_text)
                .unwrap()
                .active_id
                .as_deref(),
            Some("provider-newer")
        );
        assert!(older.exists());
        assert!(newer.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_skips_newer_invalid_backup() {
        let root = test_root("invalid");
        let primary = root.join("grox-providers.json");
        let valid = root.join("grox-providers.corrupt-100.bak");
        let invalid = root.join("grox-providers.corrupt-200.bak");
        write_profiles(&valid, "provider-valid", "https://valid.example/v1");
        std::thread::sleep(Duration::from_millis(1_100));
        fs::write(&invalid, "{not-json").unwrap();

        let recovered = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-valid", "https://valid.example/v1"),
            read_text,
            create_private,
            normalize,
        )
        .unwrap();

        assert_eq!(recovered.active_id.as_deref(), Some("provider-valid"));
        assert!(invalid.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_requires_matching_id_and_normalized_endpoint() {
        for (label, values) in [
            (
                "id-mismatch",
                managed("provider-other", "https://gateway.example/v1"),
            ),
            (
                "endpoint-mismatch",
                managed("provider-backup", "https://other.example/v1"),
            ),
        ] {
            let root = test_root(label);
            let primary = root.join("grox-providers.json");
            let backup = root.join("grox-providers.corrupt-100.bak");
            write_profiles(&backup, "provider-backup", "https://gateway.example/v1");

            let recovered = ProviderProfilesFile::read_with_recovery(
                &primary,
                &values,
                read_text,
                create_private,
                normalize,
            )
            .unwrap();

            assert!(recovered.profiles.is_empty(), "{label}");
            assert!(!primary.exists(), "{label}");
            assert!(backup.exists(), "{label}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn recovery_requires_current_compatible_metadata() {
        let root = test_root("no-identity");
        let primary = root.join("grox-providers.json");
        let backup = root.join("grox-providers.corrupt-100.bak");
        write_profiles(&backup, "provider-backup", "https://gateway.example/v1");

        let recovered = ProviderProfilesFile::read_with_recovery(
            &primary,
            &BTreeMap::new(),
            read_text,
            create_private,
            normalize,
        )
        .unwrap();

        assert!(recovered.profiles.is_empty());
        assert!(!primary.exists());
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_skips_legacy_plaintext_key_backups() {
        let root = test_root("legacy-key");
        let primary = root.join("grox-providers.json");
        let backup = root.join("grox-providers.corrupt-100.bak");
        let profile = test_profile("provider-backup", "https://gateway.example/v1");
        let mut value = serde_json::to_value(ProviderProfilesFile {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        })
        .unwrap();
        value["profiles"][0]["apiKey"] = serde_json::json!("legacy-plaintext-key");
        fs::write(&backup, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        let recovered = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-backup", "https://gateway.example/v1"),
            read_text,
            create_private,
            normalize,
        )
        .unwrap();

        assert!(recovered.profiles.is_empty());
        assert!(!primary.exists());
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_never_overwrites_existing_primary() {
        let root = test_root("primary");
        let primary = root.join("grox-providers.json");
        let backup = root.join("grox-providers.corrupt-999.bak");
        write_profiles(&primary, "provider-primary", "https://primary.example/v1");
        write_profiles(&backup, "provider-backup", "https://backup.example/v1");
        let create_calls = AtomicUsize::new(0);

        let loaded = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-backup", "https://backup.example/v1"),
            read_text,
            |_, _| {
                create_calls.fetch_add(1, Ordering::Relaxed);
                Ok(true)
            },
            normalize,
        )
        .unwrap();

        assert_eq!(loaded.active_id.as_deref(), Some("provider-primary"));
        assert_eq!(create_calls.load(Ordering::Relaxed), 0);
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_existing_primary_is_preserved_and_blocks_recovery() {
        let root = test_root("corrupt-primary");
        let primary = root.join("grox-providers.json");
        let backup = root.join("grox-providers.corrupt-999.bak");
        fs::write(&primary, "{corrupt-primary").unwrap();
        write_profiles(&backup, "provider-backup", "https://backup.example/v1");
        let create_calls = AtomicUsize::new(0);

        let result = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-backup", "https://backup.example/v1"),
            read_text,
            |_, _| {
                create_calls.fetch_add(1, Ordering::Relaxed);
                Ok(true)
            },
            normalize,
        );

        assert!(result.is_err());
        assert_eq!(create_calls.load(Ordering::Relaxed), 0);
        assert_eq!(fs::read_to_string(&primary).unwrap(), "{corrupt-primary");
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_facade_uses_injected_policy_and_atomic_publisher() {
        let root = test_root("facade");
        let primary = root.join("grox-providers.json");
        let backup = root.join("grox-providers.corrupt-100.bak");
        write_profiles(&backup, "provider-backup", "HTTPS://gateway.example/v1/");
        let normalize_calls = AtomicUsize::new(0);
        let create_calls = AtomicUsize::new(0);

        let recovered = ProviderProfilesFile::read_with_recovery(
            &primary,
            &managed("provider-backup", "https://GATEWAY.example/v1"),
            read_text,
            |path, content| {
                create_calls.fetch_add(1, Ordering::Relaxed);
                create_private(path, content)
            },
            |value, _| {
                normalize_calls.fetch_add(1, Ordering::Relaxed);
                Ok(value.to_ascii_lowercase().trim_end_matches('/').to_string())
            },
        )
        .unwrap();

        assert!(recovered.profile("provider-backup").is_some());
        assert_eq!(
            recovered
                .compatible_secret_reference(
                    &managed("provider-backup", "https://GATEWAY.example/v1"),
                    |value, _| {
                        Ok(value.to_ascii_lowercase().trim_end_matches('/').to_string())
                    },
                )
                .unwrap(),
            "provider:provider-backup"
        );
        assert_eq!(normalize_calls.load(Ordering::Relaxed), 2);
        assert_eq!(create_calls.load(Ordering::Relaxed), 1);
        assert!(primary.exists());
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_profile_reference_is_single_source_for_v032_metadata() {
        let mut profiles = ProviderProfilesFile::default();
        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Test".into(),
                "https://gateway.example.com/v1".into(),
                ProviderApiBackend::Auto,
            ),
            false,
            normalize,
        );
        profiles.active_id = Some("provider-test".into());
        let mut values = BTreeMap::from([
            (GROX_PROVIDER_KIND_KEY.into(), "compatible".into()),
            (
                GROK_MODELS_BASE_URL_KEY.into(),
                "https://gateway.example.com/v1".into(),
            ),
        ]);

        assert_eq!(
            profiles
                .compatible_secret_reference(&values, normalize)
                .unwrap(),
            SECRET_REF_DIRECT_COMPATIBLE
        );
        values.insert(GROX_PROVIDER_PROFILE_ID_KEY.into(), "provider-test".into());
        assert_eq!(
            profiles
                .compatible_secret_reference(&values, normalize)
                .unwrap(),
            "provider:provider-test"
        );
        values.insert(
            GROK_MODELS_BASE_URL_KEY.into(),
            "https://other.example/v1".into(),
        );
        assert!(profiles
            .compatible_secret_reference(&values, normalize)
            .is_err());
    }

    #[test]
    fn missing_profile_row_remains_fail_closed_when_metadata_has_id() {
        let profiles = ProviderProfilesFile::default();
        let values = managed("provider-missing", "https://gateway.example.com/v1");
        assert!(profiles
            .compatible_secret_reference(&values, normalize)
            .is_err());
    }

    #[test]
    fn catalog_update_canonicalizes_resident_models() {
        let mut profiles = ProviderProfilesFile::default();
        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Test".into(),
                "https://gateway.example/v1".into(),
                ProviderApiBackend::Auto,
            )
            .resident_models(vec!["Grok-4.3-fast".into(), "GROK-4.5".into()]),
            false,
            normalize,
        );
        profiles
            .update_catalog(
                "provider-test",
                vec!["grok-4.3-fast".into(), "grok-4.5".into()],
            )
            .unwrap();
        let profile = profiles.profile("provider-test").unwrap();
        assert_eq!(profile.resident_models, profile.available_models);
    }

    #[test]
    fn equivalent_endpoint_update_preserves_model_catalog() {
        let mut profiles = ProviderProfilesFile::default();
        let normalize_identity = |value: &str, _allow_insecure_http: bool| {
            Ok(value.to_ascii_lowercase().trim_end_matches('/').to_string())
        };
        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Test".into(),
                "https://gateway.example/v1".into(),
                ProviderApiBackend::Auto,
            ),
            false,
            normalize_identity,
        );
        profiles
            .update_catalog("provider-test", vec!["grok-build".into()])
            .unwrap();

        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Renamed".into(),
                "HTTPS://GATEWAY.EXAMPLE/v1/".into(),
                ProviderApiBackend::Auto,
            ),
            false,
            normalize_identity,
        );

        assert_eq!(
            profiles.profile("provider-test").unwrap().available_models,
            vec!["grok-build"]
        );
    }

    #[test]
    fn profile_summary_resolves_only_a_secret_reference() {
        let mut profiles = ProviderProfilesFile::default();
        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Test".into(),
                "https://gateway.example/v1".into(),
                ProviderApiBackend::Auto,
            ),
            false,
            normalize,
        );
        let summary = profiles
            .summary("provider-test", |reference, legacy| {
                assert_eq!(reference, "provider:provider-test");
                assert!(legacy.is_none());
                Ok(("keychain", true))
            })
            .unwrap();
        let json = serde_json::to_value(summary).unwrap();
        assert_eq!(json["hasApiKey"], true);
        assert_eq!(json["apiKey"], "");
    }

    #[test]
    fn provider_backend_choice_is_explicit() {
        assert_eq!(
            ProviderApiBackend::Responses.config_value("custom", "https://api.example/v1"),
            "responses"
        );
        assert_eq!(
            ProviderApiBackend::ChatCompletions.config_value("custom", "https://api.example/v1"),
            "chat_completions"
        );
        assert_eq!(
            ProviderApiBackend::Auto.config_value("DeepSeek", "https://api.deepseek.com/v1"),
            "chat_completions"
        );
    }
}
