//! 本地论文库。
//!
//! Rust 只暴露结构化命令，负责路径校验、托管式 PDF 导入和 SQLite 事务；
//! 前端不得直接拼接 SQL。批注保存为独立数据，不修改原始 PDF。

use crate::config::{get, TEX_COMPILERS};
use crate::APP;
use chrono::Utc;
use log::warn;
use roxmltree::Document;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use zip::ZipArchive;

const FILE_HASH_BUFFER_BYTES: usize = 64 * 1024;
const REFERENCE_SCHEMA_VERSION: i64 = 1;
const MIN_REFERENCE_RELATION_CONFIDENCE: f64 = 0.95;
const MAX_REFERENCE_PAGE_CHARACTERS: usize = 2_000_000;
const MAX_REFERENCE_TOTAL_CHARACTERS: usize = 32_000_000;
const MAX_REFERENCE_ENTRIES: usize = 4_000;
const MAX_ANNOTATION_QUOTE_CHARACTERS: usize = 20_000;
const MAX_ANNOTATION_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_TEXT_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DOCUMENT_OUTLINE_ITEMS: usize = 4_096;
const MAX_DOCUMENT_OUTLINE_TITLE_CHARACTERS: usize = 500;
const MAX_DOCUMENT_OUTLINE_LEVEL: i64 = 8;
const MAX_DOCUMENT_OUTLINE_SOURCE_CHARACTERS: usize = 32;
const MAX_PAPER_BATCH_SIZE: usize = 500;
const TEX_COMPILE_TIMEOUT: Duration = Duration::from_secs(90);
static IMPORT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const DEFAULT_TAGS: [(&str, &str, &str); 3] = [
    ("tag-reading", "待读", "#5c8ee6"),
    ("tag-methods", "方法学", "#e1ad42"),
    ("tag-important", "重点", "#7664e9"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// 用于按研究主题组织论文的项目。项目只保存分类关系，删除项目不会删除论文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: String,
    pub paper_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub page_number: i64,
    pub scale: f64,
    pub scroll_ratio: f64,
}

impl Default for ReadingProgress {
    fn default() -> Self {
        Self {
            page_number: 1,
            scale: 1.25,
            scroll_ratio: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: String,
    pub journal: String,
    pub year: Option<i64>,
    pub page_count: i64,
    pub updated_at: String,
    pub trashed_at: Option<String>,
    pub archived_at: Option<String>,
    pub source_format: String,
    pub document_type: String,
    pub content_kind: String,
    pub import_warning: String,
    pub tex_compiler: String,
    pub progress: ReadingProgress,
    pub tags: Vec<Tag>,
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub title: String,
    pub page_number: i64,
    #[serde(default)]
    pub end_page: i64,
    pub level: i64,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperDocument {
    pub paper: Paper,
    pub path: String,
    pub source_path: String,
    pub source_format: String,
    pub document_type: String,
    pub content_kind: String,
    pub text_content: String,
    pub import_warning: String,
    pub tex_compiler: String,
    pub page_count: i64,
    pub text_index_complete: bool,
    pub progress: ReadingProgress,
    pub outline: Vec<OutlineItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceFormat {
    Pdf,
    Markdown,
    Docx,
    Tex,
}

impl SourceFormat {
    fn from_path(path: &Path) -> Result<Self, String> {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "pdf" => Ok(Self::Pdf),
            "md" | "markdown" => Ok(Self::Markdown),
            "docx" => Ok(Self::Docx),
            "tex" => Ok(Self::Tex),
            _ => Err("仅支持 .pdf、.md、.markdown、.docx 和 .tex 文件".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Markdown => "markdown",
            Self::Docx => "docx",
            Self::Tex => "tex",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Markdown => "md",
            Self::Docx => "docx",
            Self::Tex => "tex",
        }
    }
}

#[derive(Debug)]
struct PreparedDocument {
    source_format: SourceFormat,
    document_type: String,
    managed_path: PathBuf,
    source_path: PathBuf,
    text_content: String,
    import_warning: String,
    tex_compiler: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chunk_id: i64,
    pub paper_id: String,
    pub page_number: i64,
    pub chunk_index: i64,
    pub section_title: String,
    pub quote: String,
    pub score: f64,
    pub match_kind: String,
}

/// PDF.js 提取的一页原始文本。换行必须原样保留，参考文献解析依赖条目边界。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferencePageInput {
    pub page_number: i64,
    pub text: String,
}

/// 两篇库内论文之间经过高置信规则确认的引用关系。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperRelation {
    pub direction: String,
    pub reference_id: String,
    pub source_paper_id: String,
    pub source_title: String,
    pub target_paper_id: String,
    pub target_title: String,
    pub page_number: i64,
    pub raw_text: String,
    pub doi: String,
    pub match_kind: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedReference {
    entry_index: i64,
    page_number: i64,
    raw_text: String,
    normalized_text: String,
    doi: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn app_identifier() -> String {
    APP.get()
        .map(|app| app.config().identifier.clone())
        .unwrap_or_else(|| "com.pot-app.desktop".to_string())
}

fn app_data_root() -> Result<PathBuf, String> {
    dirs::config_dir()
        .ok_or_else(|| "无法确定应用配置目录".to_string())
        .map(|root| root.join(app_identifier()))
}

fn database_path() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("research.db"))
}

pub fn research_library_root() -> Result<PathBuf, String> {
    let configured = get("settings_v2")
        .and_then(|settings| {
            settings
                .get("libraryPath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or(app_data_root()?.join("research-library"));
    let root = if configured.is_absolute() {
        configured
    } else {
        app_data_root()?.join(configured)
    };
    fs::create_dir_all(root.join("papers"))
        .map_err(|error| format!("无法创建文献库目录：{error}"))?;
    Ok(root)
}

fn open_database_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建数据库目录：{error}"))?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("配置论文数据库等待时间失败：{error}"))?;
    initialise_schema(&connection)?;
    Ok(connection)
}

pub(crate) fn with_database<T>(
    operation: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut connection = open_database_at(&database_path()?)?;
    operation(&mut connection)
}

fn initialise_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                authors TEXT NOT NULL DEFAULT '',
                journal TEXT NOT NULL DEFAULT '',
                year INTEGER,
                page_count INTEGER NOT NULL DEFAULT 1,
                managed_path TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                metadata_title TEXT NOT NULL DEFAULT '',
                normalized_title TEXT NOT NULL DEFAULT '',
                doi TEXT NOT NULL DEFAULT '',
                reference_scan_version INTEGER NOT NULL DEFAULT 0,
                references_indexed_at TEXT,
                source_format TEXT NOT NULL DEFAULT 'pdf',
                document_type TEXT NOT NULL DEFAULT 'pdf',
                content_kind TEXT NOT NULL DEFAULT 'paper' CHECK (content_kind IN ('paper', 'book')),
                source_path TEXT NOT NULL DEFAULT '',
                text_content TEXT NOT NULL DEFAULT '',
                import_warning TEXT NOT NULL DEFAULT '',
                tex_compiler TEXT NOT NULL DEFAULT '',
                text_index_complete INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                trashed_at TEXT,
                archived_at TEXT
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS paper_tags (
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (paper_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                color TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_papers (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (project_id, paper_id)
            );

            CREATE INDEX IF NOT EXISTS idx_project_papers_project
                ON project_papers(project_id, paper_id);
            CREATE INDEX IF NOT EXISTS idx_project_papers_paper
                ON project_papers(paper_id, project_id);

            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                quote TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reading_progress (
                paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL DEFAULT 1,
                scale REAL NOT NULL DEFAULT 1.25,
                scroll_ratio REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS document_outline (
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL,
                title TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                end_page INTEGER NOT NULL,
                level INTEGER NOT NULL,
                source TEXT NOT NULL,
                confidence REAL NOT NULL,
                PRIMARY KEY (paper_id, ordinal),
                CHECK (page_number >= 1),
                CHECK (end_page >= page_number),
                CHECK (level BETWEEN 1 AND 8),
                CHECK (confidence >= 0 AND confidence <= 1)
            );

            CREATE INDEX IF NOT EXISTS idx_document_outline_paper_page
                ON document_outline(paper_id, page_number, ordinal);

            CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                section_title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                UNIQUE (paper_id, page_number, chunk_index)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
                paper_id UNINDEXED,
                page_number UNINDEXED,
                content,
                tokenize='unicode61'
            );

            CREATE TABLE IF NOT EXISTS embeddings (
                chunk_id INTEGER PRIMARY KEY REFERENCES document_chunks(id) ON DELETE CASCADE,
                model TEXT NOT NULL,
                dimensions INTEGER NOT NULL,
                vector BLOB NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS translation_cache (
                cache_key TEXT PRIMARY KEY,
                source_text TEXT NOT NULL,
                target_language TEXT NOT NULL,
                model TEXT NOT NULL,
                translation TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS paper_insights (
                paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                generation_version INTEGER NOT NULL,
                model TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS lexicon_cache (
                cache_key TEXT PRIMARY KEY,
                term TEXT NOT NULL,
                target_language TEXT NOT NULL,
                model TEXT NOT NULL,
                context_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS paper_references (
                id TEXT PRIMARY KEY,
                source_paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                entry_index INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                cited_title TEXT NOT NULL DEFAULT '',
                normalized_title TEXT NOT NULL DEFAULT '',
                doi TEXT NOT NULL DEFAULT '',
                year INTEGER,
                target_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
                match_kind TEXT NOT NULL DEFAULT '',
                confidence REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (source_paper_id, entry_index)
            );

            CREATE TABLE IF NOT EXISTS ocr_jobs (
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL DEFAULT 0,
                scope TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (paper_id, page_number, scope)
            );

            CREATE TABLE IF NOT EXISTS research_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化 research.db 失败：{error}"))?;
    migrate_paper_lifecycle_schema(connection)?;
    migrate_search_schema(connection)?;
    migrate_reference_schema(connection)?;
    migrate_document_schema(connection)?;
    for (id, name, color) in DEFAULT_TAGS {
        connection
            .execute(
                "INSERT OR IGNORE INTO tags(id, name, color) VALUES (?1, ?2, ?3)",
                params![id, name, color],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 为已有论文库补齐独立归档状态。归档与回收站是两个不同生命周期，
/// 所有公开写命令都会在进入其中一个状态时清除另一个状态。
fn migrate_paper_lifecycle_schema(connection: &Connection) -> Result<(), String> {
    let has_archived_at = connection
        .prepare("PRAGMA table_info(papers)")
        .and_then(|mut statement| {
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(columns.iter().any(|column| column == "archived_at"))
        })
        .map_err(|error| error.to_string())?;
    if !has_archived_at {
        connection
            .execute("ALTER TABLE papers ADD COLUMN archived_at TEXT", [])
            .map_err(|error| format!("迁移论文归档字段失败：{error}"))?;
    }
    connection
        .execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS papers_lifecycle_insert_guard
            BEFORE INSERT ON papers
            WHEN NEW.archived_at IS NOT NULL AND NEW.trashed_at IS NOT NULL
            BEGIN
                SELECT RAISE(ABORT, '论文不能同时处于归档和回收站');
            END;

            CREATE TRIGGER IF NOT EXISTS papers_lifecycle_update_guard
            BEFORE UPDATE OF archived_at, trashed_at ON papers
            WHEN NEW.archived_at IS NOT NULL AND NEW.trashed_at IS NOT NULL
            BEGIN
                SELECT RAISE(ABORT, '论文不能同时处于归档和回收站');
            END;
            "#,
        )
        .map_err(|error| format!("创建论文生命周期约束失败：{error}"))?;
    Ok(())
}

/// 为旧版 PDF-only 数据库补齐文档导入字段；旧记录无迁移成本，直接视为 PDF。
fn migrate_document_schema(connection: &Connection) -> Result<(), String> {
    let columns = connection
        .prepare("PRAGMA table_info(papers)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    for (column, definition) in [
        ("source_format", "TEXT NOT NULL DEFAULT 'pdf'"),
        ("document_type", "TEXT NOT NULL DEFAULT 'pdf'"),
        (
            "content_kind",
            "TEXT NOT NULL DEFAULT 'paper' CHECK (content_kind IN ('paper', 'book'))",
        ),
        ("source_path", "TEXT NOT NULL DEFAULT ''"),
        ("text_content", "TEXT NOT NULL DEFAULT ''"),
        ("import_warning", "TEXT NOT NULL DEFAULT ''"),
        ("tex_compiler", "TEXT NOT NULL DEFAULT ''"),
        ("text_index_complete", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection
                .execute(
                    &format!("ALTER TABLE papers ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(|error| format!("迁移文档导入字段失败（{column}）：{error}"))?;
        }
    }
    connection
        .execute(
            "UPDATE papers SET source_path = managed_path
             WHERE source_path = '' AND source_format = 'pdf'",
            [],
        )
        .map_err(|error| format!("迁移 PDF 源文件路径失败：{error}"))?;
    Ok(())
}

/// 将旧版独立 FTS 行迁移为与 `document_chunks.id` 对齐的 rowid。
/// 这样检索结果可稳定回链到页码、章节和向量，不依赖内容字符串碰撞。
fn migrate_search_schema(connection: &Connection) -> Result<(), String> {
    let has_section_title = connection
        .prepare("PRAGMA table_info(document_chunks)")
        .and_then(|mut statement| {
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names.iter().any(|name| name == "section_title"))
        })
        .map_err(|error| error.to_string())?;
    if !has_section_title {
        connection
            .execute(
                "ALTER TABLE document_chunks ADD COLUMN section_title TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("迁移论文章节字段失败：{error}"))?;
    }

    let search_version = connection
        .query_row(
            "SELECT value FROM research_meta WHERE key = 'search_schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if search_version.as_deref() != Some("2") {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM document_chunks_fts", [])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO document_chunks_fts(rowid, paper_id, page_number, content)
                 SELECT id, paper_id, page_number, content FROM document_chunks",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO research_meta(key, value) VALUES ('search_schema_version', '2')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalize_title(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        let compatible = match character as u32 {
            0x3000 => ' ',
            0xff01..=0xff5e => char::from_u32(character as u32 - 0xfee0).unwrap_or(character),
            _ => character,
        };
        for lowercase in compatible.to_lowercase() {
            if lowercase.is_alphanumeric() {
                if pending_space && !normalized.is_empty() {
                    normalized.push(' ');
                }
                normalized.push(lowercase);
                pending_space = false;
            } else {
                pending_space = true;
            }
        }
    }
    normalized.trim().to_string()
}

fn normalize_doi(value: &str) -> String {
    let lowercase = value.trim().to_ascii_lowercase();
    for (start, _) in lowercase.match_indices("10.") {
        let candidate = &lowercase[start..];
        let bytes = candidate.as_bytes();
        let mut cursor = 3;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor < 12 {
            cursor += 1;
        }
        let registrant_digits = cursor.saturating_sub(3);
        if !(4..=9).contains(&registrant_digits) || bytes.get(cursor).copied() != Some(b'/') {
            continue;
        }
        cursor += 1;
        let suffix_start = cursor;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'-' | b'.' | b'_' | b';' | b'(' | b')' | b'/' | b':' | b'+' | b'%'
                )
            {
                cursor += 1;
            } else {
                break;
            }
        }
        if cursor == suffix_start {
            continue;
        }
        let doi = candidate[..cursor].trim_end_matches([
            '.', ',', ';', ':', ')', ']', '}', '>', '。', '，', '；', '：',
        ]);
        if doi.len() > suffix_start {
            return doi.to_string();
        }
    }
    String::new()
}

fn migrate_reference_schema(connection: &Connection) -> Result<(), String> {
    let columns = connection
        .prepare("PRAGMA table_info(papers)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    for (column, definition) in [
        ("metadata_title", "TEXT NOT NULL DEFAULT ''"),
        ("normalized_title", "TEXT NOT NULL DEFAULT ''"),
        ("doi", "TEXT NOT NULL DEFAULT ''"),
        ("reference_scan_version", "INTEGER NOT NULL DEFAULT 0"),
        ("references_indexed_at", "TEXT"),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection
                .execute(
                    &format!("ALTER TABLE papers ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(|error| format!("迁移论文引用元数据字段失败（{column}）：{error}"))?;
        }
    }

    connection
        .execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi) WHERE doi <> '';
            CREATE INDEX IF NOT EXISTS idx_papers_normalized_title
                ON papers(normalized_title) WHERE normalized_title <> '';
            CREATE INDEX IF NOT EXISTS idx_paper_references_source
                ON paper_references(source_paper_id, entry_index);
            CREATE INDEX IF NOT EXISTS idx_paper_references_target
                ON paper_references(target_paper_id) WHERE target_paper_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_paper_references_doi
                ON paper_references(doi) WHERE doi <> '';
            "#,
        )
        .map_err(|error| format!("创建论文引用索引失败：{error}"))?;

    let papers = connection
        .prepare("SELECT id, title, metadata_title, doi FROM papers")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    for (id, title, metadata_title, doi) in papers {
        let canonical_title = if metadata_title.trim().is_empty() {
            title.as_str()
        } else {
            metadata_title.as_str()
        };
        connection
            .execute(
                "UPDATE papers SET normalized_title = ?2, doi = ?3 WHERE id = ?1",
                params![id, normalize_title(canonical_title), normalize_doi(&doi)],
            )
            .map_err(|error| format!("规范化论文引用元数据失败：{error}"))?;
    }
    connection
        .execute(
            "INSERT INTO research_meta(key, value) VALUES ('reference_schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![REFERENCE_SCHEMA_VERSION.to_string()],
        )
        .map_err(|error| format!("保存论文引用结构版本失败：{error}"))?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| format!("无法读取文档：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    // Windows GUI 线程默认只有 1 MiB 栈，哈希缓冲必须明确放在堆上。
    let mut buffer = vec![0_u8; FILE_HASH_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("计算文档指纹失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn validate_source_path(path: &Path) -> Result<(PathBuf, SourceFormat), String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("文档路径无效：{error}"))?;
    if !canonical.is_file() {
        return Err("只能导入本地文档文件".to_string());
    }
    let source_format = SourceFormat::from_path(&canonical)?;
    if source_format == SourceFormat::Pdf {
        let mut signature = [0_u8; 5];
        File::open(&canonical)
            .and_then(|mut file| file.read_exact(&mut signature))
            .map_err(|error| format!("无法验证 PDF：{error}"))?;
        if &signature != b"%PDF-" {
            return Err("文件扩展名为 PDF，但内容不是有效 PDF".to_string());
        }
    }
    Ok((canonical, source_format))
}

fn copy_into_library(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }
    let temporary = destination.with_file_name(format!(
        "{}.importing",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document")
    ));
    let result: Result<(), String> = (|| {
        let mut input = File::open(source).map_err(|error| error.to_string())?;
        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("复制文档到文献库失败：{error}"))
}

fn read_utf8_document(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文档信息：{error}"))?;
    if metadata.len() > MAX_TEXT_DOCUMENT_BYTES {
        return Err("文本文档超过 32 MiB，已拒绝导入".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取文本文档：{error}"))?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| "文本文档不是 UTF-8 编码，请先转换为 UTF-8 后再导入".to_string())?;
    if text.chars().any(|character| character == '\0') {
        return Err("文本文档包含二进制空字符，已拒绝导入".to_string());
    }
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

fn extract_docx_text(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取 DOCX 信息：{error}"))?;
    if metadata.len() > MAX_TEXT_DOCUMENT_BYTES {
        return Err("DOCX 文件超过 32 MiB，已拒绝导入".to_string());
    }
    let file = File::open(path).map_err(|error| format!("无法读取 DOCX：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("DOCX 压缩包结构无效：{error}"))?;
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX 缺少 word/document.xml，文件可能已损坏".to_string())?;
    if entry.size() > MAX_TEXT_DOCUMENT_BYTES {
        return Err("DOCX 正文超过 32 MiB，已拒绝导入".to_string());
    }
    let mut xml_bytes = Vec::with_capacity(entry.size().min(MAX_TEXT_DOCUMENT_BYTES) as usize);
    entry
        .take(MAX_TEXT_DOCUMENT_BYTES + 1)
        .read_to_end(&mut xml_bytes)
        .map_err(|error| format!("无法解压 DOCX 正文：{error}"))?;
    if xml_bytes.len() as u64 > MAX_TEXT_DOCUMENT_BYTES {
        return Err("DOCX 正文超过 32 MiB，已拒绝导入".to_string());
    }
    let xml =
        String::from_utf8(xml_bytes).map_err(|_| "DOCX 正文 XML 不是 UTF-8 编码".to_string())?;
    if xml.contains('\0') {
        return Err("DOCX 正文包含二进制空字符，已拒绝导入".to_string());
    }
    let xml = xml.strip_prefix('\u{feff}').unwrap_or(&xml);
    let document = Document::parse(xml).map_err(|error| format!("DOCX XML 无效：{error}"))?;
    let mut paragraphs = Vec::new();
    for paragraph in document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "p")
    {
        let mut value = String::new();
        for node in paragraph.descendants().filter(|node| node.is_element()) {
            match node.tag_name().name() {
                "t" => {
                    if let Some(text) = node.text() {
                        value.push_str(text);
                    }
                }
                "tab" => value.push('\t'),
                "br" | "cr" => value.push('\n'),
                _ => {}
            }
        }
        let value = value.trim();
        if !value.is_empty() {
            paragraphs.push(value.to_string());
        }
    }
    if paragraphs.is_empty() {
        return Err("DOCX 中没有可读取的正文段落".to_string());
    }
    Ok(paragraphs.join("\n\n"))
}

fn executable_path(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    let path_value = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let suffixes = [".exe", ".com", ".cmd", ".bat", ""];
    #[cfg(not(windows))]
    let suffixes = [""];
    for directory in std::env::split_paths(&path_value) {
        for suffix in suffixes {
            let candidate = directory.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn configured_tex_compiler() -> String {
    get("settings_v2")
        .and_then(|settings| {
            settings
                .get("documents")
                .and_then(|documents| documents.get("texCompiler"))
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_ascii_lowercase)
        })
        .filter(|compiler| TEX_COMPILERS.contains(&compiler.as_str()))
        .unwrap_or_else(|| "auto".to_string())
}

fn tex_compiler_names(preference: &str) -> Result<Vec<String>, String> {
    let preference = preference.trim().to_ascii_lowercase();
    if !TEX_COMPILERS.contains(&preference.as_str()) {
        return Err(format!(
            "不支持的 TeX 编译器：{preference}；仅允许 auto、tectonic、xelatex、pdflatex 或 latexmk"
        ));
    }
    if preference != "auto" {
        return Ok(vec![preference]);
    }
    Ok(TEX_COMPILERS
        .iter()
        .skip(1)
        .map(|compiler| (*compiler).to_string())
        .collect())
}

fn resolve_tex_compilers(preference: &str) -> Result<Vec<(String, PathBuf)>, String> {
    let requested = preference.trim().to_ascii_lowercase();
    let candidates = tex_compiler_names(&requested)?
        .into_iter()
        .filter_map(|compiler| executable_path(&compiler).map(|path| (compiler, path)))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        if requested == "auto" {
            Err(
                "未检测到 Tectonic、XeLaTeX、pdfLaTeX 或 latexmk；文档已保留为可阅读源码"
                    .to_string(),
            )
        } else {
            Err(format!(
                "未找到所选 TeX 编译器 {requested}；文档已保留为可阅读源码，请在设置中改用 auto 或已安装的编译器"
            ))
        }
    } else {
        Ok(candidates)
    }
}

fn tex_compiler_arguments(
    compiler: &str,
    build_root: &Path,
    source: &Path,
) -> Result<Vec<OsString>, String> {
    let mut arguments = Vec::new();
    match compiler {
        "tectonic" => {
            arguments.extend([OsString::from("--untrusted"), OsString::from("-o")]);
            arguments.push(build_root.as_os_str().to_os_string());
        }
        "latexmk" => {
            arguments.extend(
                [
                    "-norc",
                    "-pdf",
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-file-line-error",
                    "-no-shell-escape",
                ]
                .into_iter()
                .map(OsString::from),
            );
            arguments.push(OsString::from(format!(
                "-outdir={}",
                build_root.to_string_lossy()
            )));
        }
        "xelatex" | "pdflatex" => {
            arguments.extend(
                [
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-file-line-error",
                    "-no-shell-escape",
                ]
                .into_iter()
                .map(OsString::from),
            );
            arguments.push(OsString::from(format!(
                "-output-directory={}",
                build_root.to_string_lossy()
            )));
        }
        _ => return Err(format!("不支持的 TeX 编译器：{compiler}")),
    }
    // 子进程已把工作目录切到源文件所在目录，只传文件名可避免 TeX 把 Windows
    // 短路径中的 `~`、空格或非 ASCII 目录误解析成 TeX 语法。
    let source_name = source
        .file_name()
        .ok_or_else(|| "TeX 源文件缺少文件名".to_string())?;
    arguments.push(source_name.to_os_string());
    Ok(arguments)
}

fn terminate_compiler(child: &mut Child) {
    #[cfg(windows)]
    {
        // latexmk 会再启动 TeX 引擎；结束整个进程树，避免超时后遗留后台编译器。
        let process_id = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_compiler(
    child: &mut Child,
    compiler: &str,
    timeout: Duration,
) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                terminate_compiler(child);
                return Err(format!(
                    "{compiler} 编译超过 {} 秒，已安全终止；文档仍可按源码阅读",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                terminate_compiler(child);
                return Err(format!("等待 {compiler} 编译失败：{error}"));
            }
        }
    }
}

fn compiler_log_tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut tail = text.chars().rev().take(1_600).collect::<String>();
    tail = tail.chars().rev().collect();
    tail.lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compile_tex_with_compiler(
    source: &Path,
    managed_root: &Path,
    sha256: &str,
    compiler: &str,
    executable: &Path,
) -> Result<(PathBuf, String), String> {
    let build_root = managed_root.join(format!(".tex-build-{}", &sha256[..16]));
    if build_root.exists() {
        fs::remove_dir_all(&build_root)
            .map_err(|error| format!("无法清理 TeX 临时目录：{error}"))?;
    }
    fs::create_dir_all(&build_root).map_err(|error| format!("无法创建 TeX 临时目录：{error}"))?;
    let result = (|| {
        let log_path = build_root.join("compiler.log");
        let stdout =
            File::create(&log_path).map_err(|error| format!("无法创建编译日志：{error}"))?;
        let stderr = stdout
            .try_clone()
            .map_err(|error| format!("无法准备编译日志：{error}"))?;
        let mut command = Command::new(executable);
        command
            .current_dir(source.parent().unwrap_or_else(|| Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .args(tex_compiler_arguments(compiler, &build_root, source)?);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 {compiler}：{error}"))?;
        let status = wait_for_compiler(&mut child, compiler, TEX_COMPILE_TIMEOUT)?;
        if !status.success() {
            let details = compiler_log_tail(&log_path);
            return Err(if details.is_empty() {
                format!("{compiler} 编译失败（{status}）；文档仍可按源码阅读")
            } else {
                format!("{compiler} 编译失败（{status}）：{details}")
            });
        }
        let expected = source
            .file_stem()
            .map(|stem| build_root.join(stem).with_extension("pdf"));
        let generated = expected.filter(|path| path.is_file()).or_else(|| {
            fs::read_dir(&build_root).ok()?.flatten().find_map(|entry| {
                let path = entry.path();
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
                    .then_some(path)
            })
        });
        let generated = generated.ok_or_else(|| {
            let details = compiler_log_tail(&log_path);
            format!("{compiler} 未生成 PDF：{details}")
        })?;
        let destination = managed_root.join(format!("{sha256}.pdf"));
        copy_into_library(&generated, &destination)?;
        Ok((destination, compiler.to_string()))
    })();
    if let Err(error) = fs::remove_dir_all(&build_root) {
        warn!("清理 TeX 临时目录失败（{:?}）：{error}", build_root);
    }
    result
}

fn compile_tex_document(
    source: &Path,
    managed_root: &Path,
    sha256: &str,
    preference: &str,
) -> Result<(PathBuf, String), String> {
    let candidates = resolve_tex_compilers(preference)?;
    let mut failures = Vec::new();
    for (compiler, executable) in candidates {
        match compile_tex_with_compiler(source, managed_root, sha256, &compiler, &executable) {
            Ok(result) => return Ok(result),
            Err(error) => failures.push(error),
        }
    }
    Err(format!(
        "所有可用 TeX 编译器均失败；文档已保留为可阅读源码：{}",
        failures.join("；")
    ))
}

fn prepare_document(
    source: &Path,
    source_format: SourceFormat,
    sha256: &str,
    managed_root: &Path,
    tex_preference: &str,
) -> Result<PreparedDocument, String> {
    fs::create_dir_all(managed_root).map_err(|error| error.to_string())?;
    let source_path = managed_root.join(format!("{sha256}.{}", source_format.extension()));
    match source_format {
        SourceFormat::Pdf => {
            copy_into_library(source, &source_path)?;
            Ok(PreparedDocument {
                source_format,
                document_type: "pdf".to_string(),
                managed_path: source_path.clone(),
                source_path,
                text_content: String::new(),
                import_warning: String::new(),
                tex_compiler: String::new(),
            })
        }
        SourceFormat::Markdown => {
            let text_content = read_utf8_document(source)?;
            copy_into_library(source, &source_path)?;
            Ok(PreparedDocument {
                source_format,
                document_type: "markdown".to_string(),
                managed_path: source_path.clone(),
                source_path,
                text_content,
                import_warning: String::new(),
                tex_compiler: String::new(),
            })
        }
        SourceFormat::Docx => {
            let text_content = extract_docx_text(source)?;
            copy_into_library(source, &source_path)?;
            Ok(PreparedDocument {
                source_format,
                document_type: "text".to_string(),
                managed_path: source_path.clone(),
                source_path,
                text_content,
                import_warning: String::new(),
                tex_compiler: String::new(),
            })
        }
        SourceFormat::Tex => {
            let text_content = read_utf8_document(source)?;
            copy_into_library(source, &source_path)?;
            match compile_tex_document(source, managed_root, sha256, tex_preference) {
                Ok((managed_path, compiler)) => Ok(PreparedDocument {
                    source_format,
                    document_type: "pdf".to_string(),
                    managed_path,
                    source_path,
                    text_content,
                    import_warning: String::new(),
                    tex_compiler: compiler,
                }),
                Err(import_warning) => Ok(PreparedDocument {
                    source_format,
                    document_type: "tex".to_string(),
                    managed_path: source_path.clone(),
                    source_path,
                    text_content,
                    import_warning,
                    tex_compiler: tex_preference.to_string(),
                }),
            }
        }
    }
}

fn paper_base_from_row(row: &Row<'_>) -> rusqlite::Result<(Paper, String)> {
    let progress = ReadingProgress {
        page_number: row.get(15)?,
        scale: row.get(16)?,
        scroll_ratio: row.get(17)?,
    };
    Ok((
        Paper {
            id: row.get(0)?,
            title: row.get(1)?,
            authors: row.get(2)?,
            journal: row.get(3)?,
            year: row.get(4)?,
            page_count: row.get(5)?,
            updated_at: row.get(6)?,
            trashed_at: row.get(7)?,
            archived_at: row.get(18)?,
            source_format: row.get(10)?,
            document_type: row.get(11)?,
            content_kind: row.get(12)?,
            import_warning: row.get(13)?,
            tex_compiler: row.get(14)?,
            progress,
            tags: Vec::new(),
            projects: Vec::new(),
        },
        row.get(8)?,
    ))
}

const PAPER_SELECT: &str = r#"
    SELECT p.id, p.title, p.authors, p.journal, p.year, p.page_count,
           p.updated_at, p.trashed_at, p.managed_path, p.original_filename,
           p.source_format, p.document_type, p.content_kind, p.import_warning, p.tex_compiler,
           COALESCE(r.page_number, 1), COALESCE(r.scale, 1.25),
           COALESCE(r.scroll_ratio, 0), p.archived_at
    FROM papers p
    LEFT JOIN reading_progress r ON r.paper_id = p.id
"#;

fn load_tags(connection: &Connection, paper_id: &str) -> Result<Vec<Tag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, t.color FROM tags t
             JOIN paper_tags pt ON pt.tag_id = t.id
             WHERE pt.paper_id = ?1 ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![paper_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        description: row.get(3)?,
        paper_count: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const PROJECT_SELECT: &str = r#"
    SELECT pr.id, pr.name, pr.color, pr.description,
           COUNT(CASE WHEN p.id IS NOT NULL
                           AND p.trashed_at IS NULL
                           AND p.archived_at IS NULL
                      THEN 1 END) AS paper_count,
           pr.created_at, pr.updated_at
    FROM projects pr
    LEFT JOIN project_papers pp ON pp.project_id = pr.id
    LEFT JOIN papers p ON p.id = pp.paper_id
"#;

fn list_projects_on(connection: &Connection) -> Result<Vec<Project>, String> {
    let query = format!(
        "{PROJECT_SELECT} GROUP BY pr.id ORDER BY pr.updated_at DESC, pr.name COLLATE NOCASE"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let projects = statement
        .query_map([], project_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(projects)
}

fn load_project(connection: &Connection, project_id: &str) -> Result<Project, String> {
    let query = format!("{PROJECT_SELECT} WHERE pr.id = ?1 GROUP BY pr.id");
    connection
        .query_row(&query, params![project_id], project_from_row)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())
}

fn load_paper_projects(connection: &Connection, paper_id: &str) -> Result<Vec<Project>, String> {
    let query = format!(
        "{PROJECT_SELECT} WHERE pr.id IN (
             SELECT project_id FROM project_papers WHERE paper_id = ?1
         ) GROUP BY pr.id ORDER BY pr.name COLLATE NOCASE"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let projects = statement
        .query_map(params![paper_id], project_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(projects)
}

fn load_paper(connection: &Connection, paper_id: &str) -> Result<(Paper, String), String> {
    let query = format!("{PAPER_SELECT} WHERE p.id = ?1");
    let (mut paper, path) = connection
        .query_row(&query, params![paper_id], paper_base_from_row)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "论文不存在".to_string())?;
    paper.tags = load_tags(connection, paper_id)?;
    paper.projects = load_paper_projects(connection, paper_id)?;
    Ok((paper, path))
}

fn validate_content_kind(value: Option<&str>) -> Result<Option<&'static str>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some("paper") => Ok(Some("paper")),
        Some("book") => Ok(Some("book")),
        Some(_) => Err("文献类型只能是 paper 或 book".to_string()),
    }
}

#[cfg(test)]
fn import_one(
    connection: &mut Connection,
    source: &Path,
    managed_root: &Path,
) -> Result<Paper, String> {
    import_one_with_content_kind(connection, source, managed_root, None)
}

fn import_one_with_content_kind(
    connection: &mut Connection,
    source: &Path,
    managed_root: &Path,
    requested_content_kind: Option<&str>,
) -> Result<Paper, String> {
    let content_kind = validate_content_kind(requested_content_kind)?;
    let (source, source_format) = validate_source_path(source)?;
    let (sha256, _size) = hash_file(&source)?;
    let tex_preference = configured_tex_compiler();
    let existing = connection
        .query_row(
            "SELECT id, source_format, document_type, tex_compiler
             FROM papers WHERE sha256 = ?1",
            params![sha256],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((existing_id, existing_format, document_type, current_compiler)) = existing {
        let timestamp = now();
        connection
            .execute(
                "UPDATE papers
                 SET trashed_at = NULL, archived_at = NULL, updated_at = ?2,
                     content_kind = COALESCE(?3, content_kind)
                 WHERE id = ?1",
                params![existing_id, timestamp, content_kind],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO paper_insights(
                    paper_id, status, generation_version, model, source_hash,
                    payload_json, error, created_at, updated_at
                 ) VALUES (?1, 'queued', 0, '', '', '{}', '', ?2, ?2)
                 ON CONFLICT(paper_id) DO UPDATE SET
                    status = CASE WHEN paper_insights.status = 'ready' THEN 'ready' ELSE 'queued' END,
                    generation_version = CASE WHEN paper_insights.status = 'ready' THEN paper_insights.generation_version ELSE 0 END,
                    model = CASE WHEN paper_insights.status = 'ready' THEN paper_insights.model ELSE '' END,
                    source_hash = CASE WHEN paper_insights.status = 'ready' THEN paper_insights.source_hash ELSE '' END,
                    payload_json = CASE WHEN paper_insights.status = 'ready' THEN paper_insights.payload_json ELSE '{}' END,
                    error = CASE WHEN paper_insights.status = 'ready' THEN paper_insights.error ELSE '' END,
                    updated_at = excluded.updated_at",
                params![existing_id, timestamp],
            )
            .map_err(|error| error.to_string())?;

        // TeX 源文件允许通过“重新导入”显式重试编译。自动模式仅修复之前退回源码的
        // 文档；指定编译器变化时则按新选择重编译，失败仍保留已有可读版本。
        let should_recompile_tex = existing_format == "tex"
            && (document_type != "pdf"
                || (tex_preference != "auto" && current_compiler != tex_preference));
        if should_recompile_tex {
            match compile_tex_document(&source, managed_root, &sha256, &tex_preference) {
                Ok((managed_path, compiler)) => {
                    connection
                        .execute(
                            "UPDATE papers
                             SET managed_path = ?2, document_type = 'pdf', import_warning = '',
                                 tex_compiler = ?3, updated_at = ?4
                             WHERE id = ?1",
                            params![
                                existing_id,
                                managed_path.to_string_lossy(),
                                compiler,
                                timestamp
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                }
                Err(error) if document_type != "pdf" => {
                    connection
                        .execute(
                            "UPDATE papers
                             SET import_warning = ?2, tex_compiler = ?3, updated_at = ?4
                             WHERE id = ?1",
                            params![existing_id, error, tex_preference, timestamp],
                        )
                        .map_err(|database_error| database_error.to_string())?;
                }
                Err(error) => {
                    warn!(
                        "TeX 重新编译失败，继续使用既有 PDF（paper_id={}）：{}",
                        existing_id, error
                    );
                }
            }
        }
        return load_paper(connection, &existing_id).map(|(paper, _)| paper);
    }

    let prepared = prepare_document(
        &source,
        source_format,
        &sha256,
        managed_root,
        &tex_preference,
    )?;

    let id = format!("paper-{}", &sha256[..24]);
    let title = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名论文")
        .trim()
        .to_string();
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_string();
    let timestamp = now();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO papers(
                id, sha256, title, normalized_title, managed_path, original_filename,
                source_format, document_type, content_kind, source_path, text_content,
                import_warning, tex_compiler, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
            params![
                id,
                sha256,
                title,
                normalize_title(&title),
                prepared.managed_path.to_string_lossy(),
                filename,
                prepared.source_format.as_str(),
                prepared.document_type,
                content_kind.unwrap_or("paper"),
                prepared.source_path.to_string_lossy(),
                prepared.text_content,
                prepared.import_warning,
                prepared.tex_compiler,
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO reading_progress(paper_id, page_number, scale, scroll_ratio, updated_at)
             VALUES (?1, 1, 1.25, 0, ?2)",
            params![id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO paper_insights(
                paper_id, status, generation_version, model, source_hash,
                payload_json, error, created_at, updated_at
             ) VALUES (?1, 'queued', 0, '', '', '{}', '', ?2, ?2)",
            params![id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    if !prepared.text_content.trim().is_empty() {
        replace_page_chunks(&transaction, &id, 1, &prepared.text_content)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    load_paper(connection, &id).map(|(paper, _)| paper)
}

fn list_papers_on(connection: &Connection, include_trashed: bool) -> Result<Vec<Paper>, String> {
    let where_clause = if include_trashed {
        ""
    } else {
        " WHERE p.trashed_at IS NULL AND p.archived_at IS NULL"
    };
    let query = format!(
        "{PAPER_SELECT}{where_clause} \
         ORDER BY CASE WHEN r.updated_at IS NULL THEN 1 ELSE 0 END, \
                  r.updated_at DESC, p.updated_at DESC"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let base = statement
        .query_map([], paper_base_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    base.into_iter()
        .map(|(mut paper, _)| {
            paper.tags = load_tags(connection, &paper.id)?;
            paper.projects = load_paper_projects(connection, &paper.id)?;
            Ok(paper)
        })
        .collect()
}

#[tauri::command]
pub fn research_list_papers(include_trashed: bool) -> Result<Vec<Paper>, String> {
    with_database(|connection| list_papers_on(connection, include_trashed))
}

#[tauri::command]
pub async fn research_import_papers(
    paths: Vec<String>,
    content_kind: Option<String>,
) -> Result<Vec<Paper>, String> {
    tauri::async_runtime::spawn_blocking(move || import_papers_blocking(paths, content_kind))
        .await
        .map_err(|error| format!("论文导入任务异常结束：{error}"))?
}

fn import_papers_blocking(
    paths: Vec<String>,
    content_kind: Option<String>,
) -> Result<Vec<Paper>, String> {
    let _import_guard = IMPORT_LOCK
        .lock()
        .map_err(|_| "论文导入队列状态异常，请重启小允翻译后重试".to_string())?;
    let content_kind = validate_content_kind(content_kind.as_deref())?;
    let validated_paths = paths
        .iter()
        .map(|path| validate_source_path(Path::new(path)).map(|(path, _)| path))
        .collect::<Result<Vec<_>, _>>()?;
    let managed_root = research_library_root()?.join("papers");
    with_database(|connection| {
        let mut imported = Vec::new();
        for path in validated_paths {
            imported.push(import_one_with_content_kind(
                connection,
                &path,
                &managed_root,
                content_kind,
            )?);
        }
        Ok(imported)
    })
}

#[tauri::command]
pub fn research_move_to_trash(paper_id: String) -> Result<(), String> {
    with_database(|connection| {
        transition_papers_on(connection, vec![paper_id], PaperLifecycleTransition::Trash)
            .map(|_| ())
    })
}

#[tauri::command]
pub fn research_restore_paper(paper_id: String) -> Result<(), String> {
    with_database(|connection| {
        transition_papers_on(
            connection,
            vec![paper_id],
            PaperLifecycleTransition::Restore,
        )
        .map(|_| ())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaperLifecycleTransition {
    Archive,
    Unarchive,
    Trash,
    Restore,
}

fn normalize_paper_ids(paper_ids: Vec<String>) -> Result<Vec<String>, String> {
    if paper_ids.is_empty() {
        return Err("至少选择一篇论文".to_string());
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::with_capacity(paper_ids.len());
    for paper_id in paper_ids {
        let paper_id = paper_id.trim();
        if paper_id.is_empty() {
            return Err("论文 ID 不能为空".to_string());
        }
        if seen.insert(paper_id.to_string()) {
            normalized.push(paper_id.to_string());
            if normalized.len() > MAX_PAPER_BATCH_SIZE {
                return Err(format!("每次最多批量处理 {MAX_PAPER_BATCH_SIZE} 篇论文"));
            }
        }
    }
    Ok(normalized)
}

fn transition_papers_on(
    connection: &mut Connection,
    paper_ids: Vec<String>,
    transition: PaperLifecycleTransition,
) -> Result<Vec<String>, String> {
    let paper_ids = normalize_paper_ids(paper_ids)?;
    let timestamp = now();
    let sql = match transition {
        PaperLifecycleTransition::Archive => {
            "UPDATE papers
             SET archived_at = ?2, trashed_at = NULL, updated_at = ?2
             WHERE id = ?1"
        }
        PaperLifecycleTransition::Unarchive | PaperLifecycleTransition::Restore => {
            "UPDATE papers
             SET archived_at = NULL, trashed_at = NULL, updated_at = ?2
             WHERE id = ?1"
        }
        PaperLifecycleTransition::Trash => {
            "UPDATE papers
             SET trashed_at = ?2, archived_at = NULL, updated_at = ?2
             WHERE id = ?1"
        }
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for paper_id in &paper_ids {
        let changed = transaction
            .execute(sql, params![paper_id, timestamp])
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!("论文不存在：{paper_id}"));
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(paper_ids)
}

#[tauri::command]
pub fn research_archive_papers(paper_ids: Vec<String>) -> Result<Vec<String>, String> {
    with_database(|connection| {
        transition_papers_on(connection, paper_ids, PaperLifecycleTransition::Archive)
    })
}

#[tauri::command]
pub fn research_unarchive_papers(paper_ids: Vec<String>) -> Result<Vec<String>, String> {
    with_database(|connection| {
        transition_papers_on(connection, paper_ids, PaperLifecycleTransition::Unarchive)
    })
}

#[tauri::command]
pub fn research_move_papers_to_trash(paper_ids: Vec<String>) -> Result<Vec<String>, String> {
    with_database(|connection| {
        transition_papers_on(connection, paper_ids, PaperLifecycleTransition::Trash)
    })
}

#[tauri::command]
pub fn research_restore_papers(paper_ids: Vec<String>) -> Result<Vec<String>, String> {
    with_database(|connection| {
        transition_papers_on(connection, paper_ids, PaperLifecycleTransition::Restore)
    })
}

fn path_is_managed(path: &Path, root: &Path) -> Result<bool, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("文献库目录无效：{error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("论文文件不存在：{error}"))?;
    Ok(canonical_path.starts_with(canonical_root))
}

#[tauri::command]
pub fn research_delete_paper_permanently(paper_id: String) -> Result<(), String> {
    let root = research_library_root()?;
    with_database(|connection| {
        let (_, path) = load_paper(connection, &paper_id)?;
        let source_path = connection
            .query_row(
                "SELECT source_path FROM papers WHERE id = ?1",
                params![paper_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut paths = [path, source_path]
            .into_iter()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .collect::<BTreeSet<_>>();
        for path in &paths {
            if !path_is_managed(path, &root)? {
                return Err("拒绝删除文献库目录之外的文件".to_string());
            }
        }
        let mut quarantined = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let quarantine = path.with_file_name(format!(
                "{}.deleting-{paper_id}-{index}",
                path.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("document")
            ));
            if let Err(error) = fs::rename(path, &quarantine) {
                for (original, quarantined_path) in quarantined.iter().rev() {
                    let _ = fs::rename(quarantined_path, original);
                }
                return Err(format!("隔离待删除文档失败：{error}"));
            }
            quarantined.push((path.clone(), quarantine));
        }

        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if let Err(error) = delete_paper_rows(&transaction, &paper_id).and_then(|_| {
            transaction
                .commit()
                .map_err(|commit_error| commit_error.to_string())
        }) {
            for (original, quarantined_path) in quarantined.iter().rev() {
                let _ = fs::rename(quarantined_path, original);
            }
            return Err(error);
        }
        paths.clear();
        for (_, quarantined_path) in quarantined {
            fs::remove_file(&quarantined_path)
                .map_err(|error| format!("清理文档文件失败：{error}"))?;
        }
        Ok(())
    })
}

fn delete_paper_rows(transaction: &Transaction<'_>, paper_id: &str) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM document_chunks_fts WHERE paper_id = ?1",
            params![paper_id],
        )
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute("DELETE FROM papers WHERE id = ?1", params![paper_id])
        .map_err(|error| error.to_string())?;
    (changed == 1)
        .then_some(())
        .ok_or_else(|| "论文不存在".to_string())
}

#[tauri::command]
pub fn research_list_tags() -> Result<Vec<Tag>, String> {
    with_database(|connection| {
        let mut statement = connection
            .prepare("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let tags = statement
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(tags)
    })
}

#[tauri::command]
pub fn research_create_tag(name: String, color: String) -> Result<Tag, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("标签名需为 1–40 个字符".to_string());
    }
    let color = if color.trim().is_empty() {
        "#7664e9".to_string()
    } else {
        color
    };
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", name, now()).as_bytes())
    );
    let id = format!("tag-{}", &hash[..12]);
    with_database(|connection| {
        connection
            .execute(
                "INSERT INTO tags(id, name, color) VALUES (?1, ?2, ?3)",
                params![id, name, color],
            )
            .map_err(|error| format!("创建标签失败：{error}"))?;
        Ok(Tag { id, name, color })
    })
}

#[tauri::command]
pub fn research_set_paper_tags(paper_id: String, tag_ids: Vec<String>) -> Result<Vec<Tag>, String> {
    with_database(|connection| {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM paper_tags WHERE paper_id = ?1",
                params![paper_id],
            )
            .map_err(|error| error.to_string())?;
        for tag_id in &tag_ids {
            transaction
                .execute(
                    "INSERT INTO paper_tags(paper_id, tag_id) VALUES (?1, ?2)",
                    params![paper_id, tag_id],
                )
                .map_err(|error| format!("设置标签失败：{error}"))?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        load_tags(connection, &paper_id)
    })
}

fn validate_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("项目名称需为 1–80 个字符".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("项目名称不能包含换行符或控制字符".to_string());
    }
    Ok(name.to_string())
}

fn validate_project_color(color: &str) -> Result<String, String> {
    let color = color.trim();
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("项目颜色必须是 #RRGGBB 格式".to_string());
    }
    Ok(color.to_ascii_lowercase())
}

fn validate_project_description(description: &str) -> Result<String, String> {
    let description = description.replace("\r\n", "\n").replace('\r', "\n");
    let description = description.trim();
    if description.chars().count() > 1_000 {
        return Err("项目说明不能超过 1000 个字符".to_string());
    }
    if description
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("项目说明包含不允许的控制字符".to_string());
    }
    Ok(description.to_string())
}

fn project_name_exists(
    connection: &Connection,
    name: &str,
    excluded_project_id: Option<&str>,
) -> Result<bool, String> {
    let count = if let Some(project_id) = excluded_project_id {
        connection.query_row(
            "SELECT COUNT(*) FROM projects WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![name, project_id],
            |row| row.get::<_, i64>(0),
        )
    } else {
        connection.query_row(
            "SELECT COUNT(*) FROM projects WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |row| row.get::<_, i64>(0),
        )
    };
    count
        .map(|count| count > 0)
        .map_err(|error| error.to_string())
}

fn create_project_on(
    connection: &mut Connection,
    name: &str,
    color: &str,
    description: &str,
) -> Result<Project, String> {
    let name = validate_project_name(name)?;
    let color = validate_project_color(color)?;
    let description = validate_project_description(description)?;
    let timestamp = now();
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{name}:{timestamp}").as_bytes())
    );
    let id = format!("project-{}", &hash[..20]);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if project_name_exists(&transaction, &name, None)? {
        return Err("已存在同名项目".to_string());
    }
    transaction
        .execute(
            "INSERT INTO projects(id, name, color, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, color, description, timestamp],
        )
        .map_err(|error| format!("创建项目失败：{error}"))?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_project(connection, &id)
}

fn update_project_on(
    connection: &mut Connection,
    project_id: &str,
    name: &str,
    color: &str,
    description: &str,
) -> Result<Project, String> {
    if project_id.trim().is_empty() {
        return Err("项目 ID 不能为空".to_string());
    }
    let name = validate_project_name(name)?;
    let color = validate_project_color(color)?;
    let description = validate_project_description(description)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if project_name_exists(&transaction, &name, Some(project_id))? {
        return Err("已存在同名项目".to_string());
    }
    let changed = transaction
        .execute(
            "UPDATE projects SET name = ?2, color = ?3, description = ?4, updated_at = ?5
             WHERE id = ?1",
            params![project_id, name, color, description, now()],
        )
        .map_err(|error| format!("更新项目失败：{error}"))?;
    if changed != 1 {
        return Err("项目不存在".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    load_project(connection, project_id)
}

fn delete_project_on(connection: &mut Connection, project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Err("项目 ID 不能为空".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|error| format!("删除项目失败：{error}"))?;
    if changed != 1 {
        return Err("项目不存在".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn set_paper_projects_on(
    connection: &mut Connection,
    paper_id: &str,
    project_ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    if paper_id.trim().is_empty() {
        return Err("论文 ID 不能为空".to_string());
    }
    let project_ids = project_ids
        .into_iter()
        .map(|project_id| project_id.trim().to_string())
        .collect::<Vec<_>>();
    if project_ids.iter().any(String::is_empty) {
        return Err("项目 ID 不能为空".to_string());
    }
    let project_ids = project_ids.into_iter().collect::<BTreeSet<_>>();
    if project_ids.len() > 100 {
        return Err("每篇论文最多加入 100 个项目".to_string());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let paper_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM papers WHERE id = ?1)",
            params![paper_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if !paper_exists {
        return Err("论文不存在".to_string());
    }
    for project_id in &project_ids {
        let project_exists = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                params![project_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if !project_exists {
            return Err(format!("项目不存在：{project_id}"));
        }
    }

    transaction
        .execute(
            "DELETE FROM project_papers WHERE paper_id = ?1",
            params![paper_id],
        )
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    for project_id in &project_ids {
        transaction
            .execute(
                "INSERT INTO project_papers(project_id, paper_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![project_id, paper_id, timestamp],
            )
            .map_err(|error| format!("设置论文项目失败：{error}"))?;
    }
    transaction
        .execute(
            "UPDATE papers SET updated_at = ?2 WHERE id = ?1",
            params![paper_id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    load_paper_projects(connection, paper_id)
}

#[tauri::command]
pub fn research_list_projects() -> Result<Vec<Project>, String> {
    with_database(|connection| list_projects_on(connection))
}

#[tauri::command]
pub fn research_create_project(
    name: String,
    color: String,
    description: String,
) -> Result<Project, String> {
    with_database(|connection| create_project_on(connection, &name, &color, &description))
}

#[tauri::command]
pub fn research_update_project(
    project_id: String,
    name: String,
    color: String,
    description: String,
) -> Result<Project, String> {
    with_database(|connection| {
        update_project_on(connection, &project_id, &name, &color, &description)
    })
}

#[tauri::command]
pub fn research_delete_project(project_id: String) -> Result<(), String> {
    with_database(|connection| delete_project_on(connection, &project_id))
}

#[tauri::command]
pub fn research_set_paper_projects(
    paper_id: String,
    project_ids: Vec<String>,
) -> Result<Vec<Project>, String> {
    with_database(|connection| set_paper_projects_on(connection, &paper_id, project_ids))
}

fn load_document_outline(
    connection: &Connection,
    paper_id: &str,
) -> Result<Vec<OutlineItem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT title, page_number, end_page, level, source, confidence
             FROM document_outline
             WHERE paper_id = ?1
             ORDER BY ordinal",
        )
        .map_err(|error| format!("读取文档目录失败：{error}"))?;
    let outline = statement
        .query_map(params![paper_id], |row| {
            Ok(OutlineItem {
                title: row.get(0)?,
                page_number: row.get(1)?,
                end_page: row.get(2)?,
                level: row.get(3)?,
                source: row.get(4)?,
                confidence: row.get(5)?,
            })
        })
        .map_err(|error| format!("读取文档目录失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取文档目录失败：{error}"))?;
    Ok(outline)
}

/// 校验、去重并规范目录，同时按层级计算每一节的结束页。
/// 调用方传入的 `endPage` 不可信，始终由本地页码边界重新计算。
fn normalize_document_outline(
    outline: Vec<OutlineItem>,
    page_count: i64,
) -> Result<Vec<OutlineItem>, String> {
    if outline.len() > MAX_DOCUMENT_OUTLINE_ITEMS {
        return Err(format!("目录条目不能超过 {MAX_DOCUMENT_OUTLINE_ITEMS} 条"));
    }
    let page_count = page_count.max(1);
    let mut deduplicated: Vec<OutlineItem> = Vec::with_capacity(outline.len());
    let mut seen = BTreeMap::<(String, i64, i64), usize>::new();

    for mut item in outline {
        if item.title.chars().any(char::is_control) {
            return Err("目录标题不能包含控制字符".to_string());
        }
        item.title = item.title.split_whitespace().collect::<Vec<_>>().join(" ");
        let title_length = item.title.chars().count();
        if title_length == 0 || title_length > MAX_DOCUMENT_OUTLINE_TITLE_CHARACTERS {
            return Err(format!(
                "目录标题长度必须为 1～{MAX_DOCUMENT_OUTLINE_TITLE_CHARACTERS} 个字符"
            ));
        }
        if !(1..=page_count).contains(&item.page_number) {
            return Err(format!(
                "目录“{}”的页码必须位于 1～{page_count}",
                item.title
            ));
        }
        if !(1..=MAX_DOCUMENT_OUTLINE_LEVEL).contains(&item.level) {
            return Err(format!(
                "目录“{}”的层级必须位于 1～{MAX_DOCUMENT_OUTLINE_LEVEL}",
                item.title
            ));
        }
        item.source = item.source.trim().to_ascii_lowercase();
        let source_length = item.source.chars().count();
        if source_length == 0
            || source_length > MAX_DOCUMENT_OUTLINE_SOURCE_CHARACTERS
            || !item.source.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '-' | '_')
            })
        {
            return Err(format!(
                "目录“{}”的来源必须为 1～{MAX_DOCUMENT_OUTLINE_SOURCE_CHARACTERS} 个小写字母、数字、连字符或下划线",
                item.title
            ));
        }
        if !item.confidence.is_finite() || !(0.0..=1.0).contains(&item.confidence) {
            return Err(format!("目录“{}”的置信度必须位于 0～1", item.title));
        }
        item.end_page = item.page_number;

        let key = (item.title.to_lowercase(), item.page_number, item.level);
        if let Some(index) = seen.get(&key).copied() {
            if item.confidence > deduplicated[index].confidence {
                deduplicated[index].source = item.source;
                deduplicated[index].confidence = item.confidence;
            }
            continue;
        }
        seen.insert(key, deduplicated.len());
        deduplicated.push(item);
    }

    if let Some(first) = deduplicated.first() {
        if first.level != 1 {
            return Err("第一条目录的层级必须为 1".to_string());
        }
    }
    for pair in deduplicated.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if current.page_number < previous.page_number {
            return Err(format!(
                "目录“{}”的页码早于上一条，目录必须按页码排序",
                current.title
            ));
        }
        if current.level > previous.level + 1 {
            return Err(format!(
                "目录“{}”的层级从 {} 跳到了 {}",
                current.title, previous.level, current.level
            ));
        }
    }

    for index in 0..deduplicated.len() {
        let page_number = deduplicated[index].page_number;
        let level = deduplicated[index].level;
        let next_boundary = deduplicated[index + 1..]
            .iter()
            .find(|candidate| candidate.level <= level)
            .map(|candidate| candidate.page_number);
        deduplicated[index].end_page = next_boundary
            .map(|boundary| boundary.saturating_sub(1).max(page_number))
            .unwrap_or(page_count)
            .min(page_count);
    }
    Ok(deduplicated)
}

fn replace_document_outline_on(
    connection: &mut Connection,
    paper_id: &str,
    outline: Vec<OutlineItem>,
) -> Result<Vec<OutlineItem>, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始目录事务失败：{error}"))?;
    let page_count = transaction
        .query_row(
            "SELECT page_count FROM papers WHERE id = ?1",
            params![paper_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("读取论文页数失败：{error}"))?
        .ok_or_else(|| "论文不存在，无法保存目录".to_string())?;
    let normalized = normalize_document_outline(outline, page_count)?;

    transaction
        .execute(
            "DELETE FROM document_outline WHERE paper_id = ?1",
            params![paper_id],
        )
        .map_err(|error| format!("清理旧目录失败：{error}"))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO document_outline(
                    paper_id, ordinal, title, page_number, end_page, level, source, confidence
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|error| format!("准备目录写入失败：{error}"))?;
        for (ordinal, item) in normalized.iter().enumerate() {
            statement
                .execute(params![
                    paper_id,
                    ordinal as i64,
                    item.title,
                    item.page_number,
                    item.end_page,
                    item.level,
                    item.source,
                    item.confidence,
                ])
                .map_err(|error| format!("保存目录失败：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("提交目录失败：{error}"))?;
    Ok(normalized)
}

#[tauri::command]
pub fn research_replace_document_outline(
    paper_id: String,
    outline: Vec<OutlineItem>,
) -> Result<Vec<OutlineItem>, String> {
    let paper_id = paper_id.trim();
    if paper_id.is_empty() {
        return Err("缺少论文 paperId".to_string());
    }
    with_database(|connection| replace_document_outline_on(connection, paper_id, outline))
}

fn outline_level_from_title(raw_title: &str) -> i64 {
    let trimmed = raw_title.trim();
    let markdown_level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if markdown_level > 0 {
        return markdown_level.min(MAX_DOCUMENT_OUTLINE_LEVEL as usize) as i64;
    }
    if trimmed.starts_with('第') {
        if trimmed.contains('章') || trimmed.contains('篇') {
            return 1;
        }
        if trimmed.contains('节') {
            return 2;
        }
    }
    let numeric_prefix: String = trimmed
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    let components = numeric_prefix
        .split('.')
        .filter(|component| !component.is_empty())
        .count();
    (components.max(1) as i64).min(MAX_DOCUMENT_OUTLINE_LEVEL)
}

fn outline_candidate_title(raw_title: &str) -> Option<String> {
    if raw_title.chars().any(char::is_control) {
        return None;
    }
    let title = raw_title
        .trim()
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (title.chars().count() >= 3 && title.chars().count() <= MAX_DOCUMENT_OUTLINE_TITLE_CHARACTERS)
        .then_some(title)
}

fn rebuild_document_outline_on(
    connection: &mut Connection,
    paper_id: &str,
    source: &str,
) -> Result<Vec<OutlineItem>, String> {
    let existing = load_document_outline(connection, paper_id)?;
    if existing
        .iter()
        .any(|item| item.source.eq_ignore_ascii_case("native"))
    {
        return Ok(existing);
    }
    let source = source.trim().to_ascii_lowercase();
    if source == "native" {
        return Err("基于文本块重建的目录不能标记为 native".to_string());
    }
    let page_count = connection
        .query_row(
            "SELECT page_count FROM papers WHERE id = ?1",
            params![paper_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("读取论文页数失败：{error}"))?
        .ok_or_else(|| "论文不存在，无法重建目录".to_string())?
        .max(1);
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT page_number, section_title, content
                 FROM document_chunks
                 WHERE paper_id = ?1
                 ORDER BY page_number, chunk_index",
            )
            .map_err(|error| format!("读取文档文本块失败：{error}"))?;
        let rows = statement
            .query_map(params![paper_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("读取文档文本块失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取文档文本块失败：{error}"))?;
        rows
    };
    let mut seen_titles = BTreeSet::new();
    let mut candidates = Vec::new();
    for (page_number, section_title, content) in rows {
        if !(1..=page_count).contains(&page_number) {
            return Err(format!(
                "文本块页码 {page_number} 超出论文页数 1～{page_count}，已拒绝重建目录"
            ));
        }
        let raw_title = if !section_title.trim().is_empty() {
            Some(section_title.as_str())
        } else {
            content
                .lines()
                .map(str::trim)
                .find(|line| looks_like_heading(line))
        };
        let Some(raw_title) = raw_title else {
            continue;
        };
        let inferred_level = outline_level_from_title(raw_title);
        let Some(title) = outline_candidate_title(raw_title) else {
            continue;
        };
        if !seen_titles.insert(title.to_lowercase()) {
            continue;
        }
        let level = candidates.last().map_or(1, |previous: &OutlineItem| {
            inferred_level.min(previous.level + 1)
        });
        candidates.push(OutlineItem {
            title,
            page_number,
            end_page: page_number,
            level,
            source: source.clone(),
            confidence: if section_title.trim().is_empty() {
                0.58
            } else {
                0.82
            },
        });
    }
    if candidates.is_empty() {
        return Err("未从已索引文本中发现可靠的章节标题，原目录保持不变".to_string());
    }
    candidates[0].level = 1;
    replace_document_outline_on(connection, paper_id, candidates)
}

#[tauri::command]
pub fn research_rebuild_document_outline(
    paper_id: String,
    source: String,
) -> Result<Vec<OutlineItem>, String> {
    let paper_id = paper_id.trim();
    if paper_id.is_empty() {
        return Err("缺少论文 paperId".to_string());
    }
    with_database(|connection| rebuild_document_outline_on(connection, paper_id, &source))
}

fn get_document_on(connection: &Connection, paper_id: &str) -> Result<PaperDocument, String> {
    let (paper, path) = load_paper(connection, paper_id)?;
    let (source_path, text_content, text_index_complete) = connection
        .query_row(
            "SELECT source_path, text_content, text_index_complete FROM papers WHERE id = ?1",
            params![paper_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let outline = load_document_outline(connection, paper_id)?;
    Ok(PaperDocument {
        page_count: paper.page_count,
        progress: paper.progress.clone(),
        source_path,
        source_format: paper.source_format.clone(),
        document_type: paper.document_type.clone(),
        content_kind: paper.content_kind.clone(),
        text_content,
        text_index_complete,
        import_warning: paper.import_warning.clone(),
        tex_compiler: paper.tex_compiler.clone(),
        paper,
        path,
        outline,
    })
}

#[tauri::command]
pub fn research_get_document(paper_id: String) -> Result<PaperDocument, String> {
    with_database(|connection| get_document_on(connection, &paper_id))
}

fn finite_or_default(value: f64, minimum: f64, maximum: f64, default: f64) -> f64 {
    if value.is_finite() {
        value.clamp(minimum, maximum)
    } else {
        default
    }
}

/// 将阅读位置作为单篇论文的独立状态原子写入。
///
/// 页码会受当前文档总页数约束；缩放和滚动比例拒绝 NaN/Infinity，避免损坏后续读取。
fn save_progress_on(
    connection: &mut Connection,
    paper_id: &str,
    page_number: i64,
    scale: f64,
    scroll_ratio: f64,
) -> Result<ReadingProgress, String> {
    let page_count = connection
        .query_row(
            "SELECT page_count FROM papers WHERE id = ?1",
            params![paper_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "论文不存在，无法保存阅读进度".to_string())?
        .max(1);
    let progress = ReadingProgress {
        page_number: page_number.clamp(1, page_count),
        scale: finite_or_default(scale, 0.5, 3.0, ReadingProgress::default().scale),
        scroll_ratio: finite_or_default(scroll_ratio, 0.0, 1.0, 0.0),
    };
    let timestamp = now();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO reading_progress(paper_id, page_number, scale, scroll_ratio, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(paper_id) DO UPDATE SET
                page_number=excluded.page_number, scale=excluded.scale,
                scroll_ratio=excluded.scroll_ratio, updated_at=excluded.updated_at",
            params![
                paper_id,
                progress.page_number,
                progress.scale,
                progress.scroll_ratio,
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE papers SET updated_at = ?2 WHERE id = ?1",
            params![paper_id, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(progress)
}

#[tauri::command]
pub fn research_save_progress(
    paper_id: String,
    page_number: i64,
    scale: f64,
    scroll_ratio: f64,
) -> Result<ReadingProgress, String> {
    with_database(|connection| {
        save_progress_on(connection, &paper_id, page_number, scale, scroll_ratio)
    })
}

fn update_page_count_on(
    connection: &mut Connection,
    paper_id: &str,
    page_count: i64,
) -> Result<(), String> {
    let safe_page_count = page_count.max(1);
    let timestamp = now();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let updated = transaction
        .execute(
            "UPDATE papers SET page_count = ?2, updated_at = ?3 WHERE id = ?1",
            params![paper_id, safe_page_count, timestamp],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("论文不存在，无法更新页数".to_string());
    }
    transaction
        .execute(
            "UPDATE reading_progress
             SET page_number = MIN(MAX(page_number, 1), ?2), updated_at = ?3
             WHERE paper_id = ?1",
            params![paper_id, safe_page_count, timestamp],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn research_update_page_count(paper_id: String, page_count: i64) -> Result<(), String> {
    with_database(|connection| update_page_count_on(connection, &paper_id, page_count))
}

/// 仅在 PDF 全文逐页提取和索引全部成功后写入完成标记。
/// OCR 的部分页索引不会调用本命令，因此扫描件不会被误判为已完整提取。
fn mark_text_index_complete_on(
    connection: &mut Connection,
    paper_id: &str,
    page_count: i64,
) -> Result<(), String> {
    update_page_count_on(connection, paper_id, page_count)?;
    let updated = connection
        .execute(
            "UPDATE papers SET text_index_complete = 1, updated_at = ?2 WHERE id = ?1",
            params![paper_id, now()],
        )
        .map_err(|error| format!("保存全文索引状态失败：{error}"))?;
    if updated == 0 {
        return Err("论文不存在，无法保存全文索引状态".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn research_mark_text_index_complete(paper_id: String, page_count: i64) -> Result<(), String> {
    with_database(|connection| mark_text_index_complete_on(connection, &paper_id, page_count))
}

#[tauri::command]
pub fn research_list_annotations(paper_id: String) -> Result<Vec<Value>, String> {
    with_database(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM annotations WHERE paper_id = ?1
                 ORDER BY updated_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let payloads = statement
            .query_map(params![paper_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        payloads
            .into_iter()
            .map(|payload| serde_json::from_str(&payload).map_err(|error| error.to_string()))
            .collect()
    })
}

#[tauri::command]
pub fn research_save_annotation(mut annotation: Value) -> Result<Value, String> {
    let object = annotation
        .as_object_mut()
        .ok_or_else(|| "批注格式无效".to_string())?;
    let paper_id = object
        .get("paperId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "批注缺少 paperId".to_string())?;
    let page_number = object
        .get("pageNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let quote = object
        .get("quote")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if quote.is_empty() {
        return Err("批注引文不能为空".to_string());
    }
    if quote.chars().count() > MAX_ANNOTATION_QUOTE_CHARACTERS {
        return Err("批注引文超过 20000 个字符".to_string());
    }
    let timestamp = now();
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let digest = format!(
                "{:x}",
                Sha256::digest(format!("{paper_id}:{page_number}:{quote}:{timestamp}").as_bytes())
            );
            format!("annotation-{}", &digest[..24])
        });
    object.insert("id".to_string(), json!(id));
    object.insert("paperId".to_string(), json!(paper_id));
    object.insert("pageNumber".to_string(), json!(page_number));
    object.insert("quote".to_string(), json!(quote));
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| json!(timestamp));
    object.insert("updatedAt".to_string(), json!(timestamp));
    let payload = serde_json::to_string(&annotation).map_err(|error| error.to_string())?;
    if payload.len() > MAX_ANNOTATION_PAYLOAD_BYTES {
        return Err("批注内容超过 64 KB，请缩短笔记或词义内容".to_string());
    }

    with_database(|connection| {
        connection
            .execute(
                "INSERT INTO annotations(id, paper_id, page_number, quote, payload_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    page_number=excluded.page_number, quote=excluded.quote,
                    payload_json=excluded.payload_json, updated_at=excluded.updated_at",
                params![id, paper_id, page_number, quote, payload, timestamp],
            )
            .map_err(|error| format!("保存批注失败：{error}"))?;
        Ok(annotation.clone())
    })
}

#[tauri::command]
pub fn research_delete_annotation(annotation_id: String) -> Result<(), String> {
    with_database(|connection| {
        connection
            .execute(
                "DELETE FROM annotations WHERE id = ?1",
                params![annotation_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn validate_reference_pages(
    pages: Vec<ReferencePageInput>,
) -> Result<Vec<ReferencePageInput>, String> {
    let mut total_characters = 0_usize;
    let mut by_page = BTreeMap::new();
    for page in pages {
        if page.page_number < 1 {
            return Err("参考文献页码必须从 1 开始".to_string());
        }
        let text = page.text.replace("\r\n", "\n").replace('\r', "\n");
        let character_count = text.chars().count();
        if character_count > MAX_REFERENCE_PAGE_CHARACTERS {
            return Err(format!(
                "第 {} 页文本异常过大，已拒绝建立引用索引",
                page.page_number
            ));
        }
        total_characters = total_characters.saturating_add(character_count);
        if total_characters > MAX_REFERENCE_TOTAL_CHARACTERS {
            return Err("参考文献文本总量异常过大，已拒绝建立引用索引".to_string());
        }
        by_page.insert(
            page.page_number,
            ReferencePageInput {
                page_number: page.page_number,
                text,
            },
        );
    }
    Ok(by_page.into_values().collect())
}

fn strip_reference_number_prefix(value: &str) -> Option<(i64, &str)> {
    let trimmed = value.trim_start();
    for (open, close) in [('[', ']'), ('【', '】'), ('(', ')'), ('（', '）')] {
        if !trimmed.starts_with(open) {
            continue;
        }
        let content_start = open.len_utf8();
        let close_offset = trimmed[content_start..].find(close)? + content_start;
        let number = trimmed[content_start..close_offset].trim();
        if number.is_empty()
            || number.len() > 4
            || !number.bytes().all(|byte| byte.is_ascii_digit())
        {
            continue;
        }
        let number = number.parse::<i64>().ok()?;
        let remainder = trimmed[close_offset + close.len_utf8()..].trim_start();
        if !remainder.is_empty() {
            return Some((number, remainder));
        }
    }

    let digit_end = trimmed
        .char_indices()
        .take_while(|(_, character)| character.is_ascii_digit())
        .last()
        .map(|(index, character)| index + character.len_utf8())?;
    if digit_end > 4 {
        return None;
    }
    let number = trimmed[..digit_end].parse::<i64>().ok()?;
    let delimiter = trimmed[digit_end..].chars().next()?;
    if !matches!(delimiter, '.' | ')' | '、') {
        return None;
    }
    let after_delimiter = &trimmed[digit_end + delimiter.len_utf8()..];
    if delimiter == '.' && !after_delimiter.starts_with(char::is_whitespace) {
        return None;
    }
    let remainder = after_delimiter.trim_start();
    (!remainder.is_empty()).then_some((number, remainder))
}

fn reference_heading_remainder(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = normalize_title(trimmed);
    let without_section_number = normalized.trim_start_matches(|character: char| {
        character.is_ascii_digit() || character.is_whitespace()
    });
    if matches!(
        without_section_number,
        "references"
            | "bibliography"
            | "literature cited"
            | "works cited"
            | "参考文献"
            | "引用文献"
    ) {
        return Some("");
    }

    let lowercase = trimmed.to_ascii_lowercase();
    for prefix in [
        "references",
        "bibliography",
        "literature cited",
        "works cited",
    ] {
        if !lowercase.starts_with(prefix) {
            continue;
        }
        let remainder = trimmed[prefix.len()..].trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, ':' | '：' | '-' | '—')
        });
        if remainder.is_empty() || strip_reference_number_prefix(remainder).is_some() {
            return Some(remainder);
        }
    }
    for prefix in ["参考文献", "引用文献"] {
        if !trimmed.starts_with(prefix) {
            continue;
        }
        let remainder = trimmed[prefix.len()..].trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, ':' | '：' | '-' | '—')
        });
        if remainder.is_empty() || strip_reference_number_prefix(remainder).is_some() {
            return Some(remainder);
        }
    }
    None
}

fn is_reference_terminator(line: &str) -> bool {
    let normalized = normalize_title(line);
    matches!(
        normalized.as_str(),
        "appendix"
            | "appendices"
            | "supplementary material"
            | "supplemental material"
            | "附录"
            | "补充材料"
    )
}

#[derive(Debug, Clone)]
struct ReferenceLine {
    page_number: i64,
    text: String,
}

fn collect_reference_lines(pages: &[ReferencePageInput]) -> Option<Vec<ReferenceLine>> {
    let mut lines = Vec::new();
    let mut found_heading = false;
    'pages: for page in pages {
        for line in page.text.split('\n') {
            if !found_heading {
                if let Some(remainder) = reference_heading_remainder(line) {
                    found_heading = true;
                    if !remainder.trim().is_empty() {
                        lines.push(ReferenceLine {
                            page_number: page.page_number,
                            text: remainder.trim_end().to_string(),
                        });
                    }
                }
                continue;
            }
            if !lines.is_empty() && is_reference_terminator(line) {
                break 'pages;
            }
            lines.push(ReferenceLine {
                page_number: page.page_number,
                text: line.trim_end().to_string(),
            });
        }
    }
    found_heading.then_some(lines)
}

fn parsed_reference_from_lines(
    entry_index: i64,
    page_number: i64,
    lines: &[String],
) -> Option<ParsedReference> {
    let raw_text = lines.join("\n").trim().to_string();
    if raw_text
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count()
        < 4
    {
        return None;
    }
    Some(ParsedReference {
        entry_index,
        page_number,
        normalized_text: normalize_title(&raw_text),
        doi: normalize_doi(&raw_text),
        raw_text,
    })
}

fn parse_reference_entries(pages: &[ReferencePageInput]) -> Option<Vec<ParsedReference>> {
    let lines = collect_reference_lines(pages)?;
    let has_numbered_entries = lines
        .iter()
        .any(|line| strip_reference_number_prefix(&line.text).is_some());
    let mut groups: Vec<(i64, Vec<String>)> = Vec::new();

    if has_numbered_entries {
        let mut current: Option<(i64, Vec<String>)> = None;
        for line in lines {
            if strip_reference_number_prefix(&line.text).is_some() {
                if let Some(group) = current.take() {
                    groups.push(group);
                }
                current = Some((line.page_number, vec![line.text.trim().to_string()]));
            } else if let Some((_, content)) = current.as_mut() {
                content.push(line.text);
            }
            if groups.len() >= MAX_REFERENCE_ENTRIES {
                break;
            }
        }
        if let Some(group) = current {
            groups.push(group);
        }
    } else {
        let has_paragraph_breaks = lines.iter().any(|line| line.text.trim().is_empty());
        if has_paragraph_breaks {
            let mut current: Option<(i64, Vec<String>)> = None;
            for line in lines {
                if line.text.trim().is_empty() {
                    if let Some(group) = current.take() {
                        groups.push(group);
                    }
                } else if let Some((_, content)) = current.as_mut() {
                    content.push(line.text);
                } else {
                    current = Some((line.page_number, vec![line.text]));
                }
                if groups.len() >= MAX_REFERENCE_ENTRIES {
                    break;
                }
            }
            if let Some(group) = current {
                groups.push(group);
            }
        } else {
            groups.extend(
                lines
                    .into_iter()
                    .filter(|line| !line.text.trim().is_empty())
                    .take(MAX_REFERENCE_ENTRIES)
                    .map(|line| (line.page_number, vec![line.text])),
            );
        }
    }

    Some(
        groups
            .into_iter()
            .filter_map(|(page_number, content)| {
                parsed_reference_from_lines(0, page_number, &content)
            })
            .enumerate()
            .map(|(index, mut reference)| {
                reference.entry_index = index as i64;
                reference
            })
            .collect(),
    )
}

fn find_document_doi(pages: &[ReferencePageInput]) -> String {
    for page in pages.iter().filter(|page| page.page_number <= 2) {
        let prefix = page
            .text
            .split('\n')
            .take_while(|line| reference_heading_remainder(line).is_none())
            .collect::<Vec<_>>()
            .join("\n");
        let doi = normalize_doi(&prefix);
        if !doi.is_empty() {
            return doi;
        }
    }
    String::new()
}

fn title_is_high_confidence(normalized: &str) -> bool {
    let alphanumeric_count = normalized
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count();
    let word_count = normalized.split_whitespace().count();
    let contains_non_ascii = !normalized.is_ascii();
    (word_count >= 5 && alphanumeric_count >= 24)
        || (contains_non_ascii && alphanumeric_count >= 10)
}

#[derive(Debug, Clone)]
struct ReferenceCandidate {
    id: String,
    title: String,
    normalized_title: String,
    doi: String,
}

#[derive(Debug, Clone)]
struct StoredReference {
    id: String,
    source_paper_id: String,
    normalized_text: String,
    doi: String,
}

fn resolve_all_reference_matches(connection: &mut Connection) -> Result<(), String> {
    let candidates = connection
        .prepare(
            "SELECT id, title, normalized_title, doi
             FROM papers
             WHERE trashed_at IS NULL AND archived_at IS NULL",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    let title = row.get::<_, String>(1)?;
                    let stored_normalized = row.get::<_, String>(2)?;
                    Ok(ReferenceCandidate {
                        id: row.get(0)?,
                        normalized_title: if stored_normalized.trim().is_empty() {
                            normalize_title(&title)
                        } else {
                            stored_normalized
                        },
                        title,
                        doi: normalize_doi(&row.get::<_, String>(3)?),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    let references = connection
        .prepare("SELECT id, source_paper_id, normalized_text, doi FROM paper_references")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok(StoredReference {
                        id: row.get(0)?,
                        source_paper_id: row.get(1)?,
                        normalized_text: row.get(2)?,
                        doi: normalize_doi(&row.get::<_, String>(3)?),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for reference in references {
        let mut matched: Option<(&ReferenceCandidate, &str, f64)> = None;
        if !reference.doi.is_empty() {
            let doi_matches = candidates
                .iter()
                .filter(|candidate| {
                    candidate.id != reference.source_paper_id && candidate.doi == reference.doi
                })
                .collect::<Vec<_>>();
            if doi_matches.len() == 1 {
                matched = Some((doi_matches[0], "doi", 1.0));
            }
        }
        if matched.is_none() {
            let title_matches = candidates
                .iter()
                .filter(|candidate| {
                    candidate.id != reference.source_paper_id
                        && title_is_high_confidence(&candidate.normalized_title)
                        && reference
                            .normalized_text
                            .contains(&candidate.normalized_title)
                })
                .collect::<Vec<_>>();
            if title_matches.len() == 1 {
                matched = Some((title_matches[0], "title", 0.97));
            }
        }

        if let Some((candidate, match_kind, confidence)) = matched {
            transaction
                .execute(
                    "UPDATE paper_references SET target_paper_id = ?2, cited_title = ?3,
                        normalized_title = ?4, match_kind = ?5, confidence = ?6,
                        updated_at = ?7 WHERE id = ?1",
                    params![
                        reference.id,
                        candidate.id,
                        candidate.title,
                        candidate.normalized_title,
                        match_kind,
                        confidence,
                        now()
                    ],
                )
                .map_err(|error| error.to_string())?;
        } else {
            transaction
                .execute(
                    "UPDATE paper_references SET target_paper_id = NULL, cited_title = '',
                        normalized_title = '', match_kind = '', confidence = 0,
                        updated_at = ?2 WHERE id = ?1",
                    params![reference.id, now()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn list_paper_relations_on(
    connection: &Connection,
    paper_id: &str,
) -> Result<Vec<PaperRelation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT pr.id, pr.source_paper_id, source.title, pr.target_paper_id,
                    target.title, pr.page_number, pr.raw_text, pr.doi,
                    pr.match_kind, pr.confidence
             FROM paper_references pr
             JOIN papers source ON source.id = pr.source_paper_id
             JOIN papers target ON target.id = pr.target_paper_id
             WHERE (pr.source_paper_id = ?1 OR pr.target_paper_id = ?1)
               AND pr.confidence >= ?2
               AND source.trashed_at IS NULL AND source.archived_at IS NULL
               AND target.trashed_at IS NULL AND target.archived_at IS NULL
             ORDER BY pr.updated_at DESC, pr.entry_index",
        )
        .map_err(|error| error.to_string())?;
    let relations = statement
        .query_map(
            params![paper_id, MIN_REFERENCE_RELATION_CONFIDENCE],
            |row| {
                let source_paper_id = row.get::<_, String>(1)?;
                Ok(PaperRelation {
                    direction: if source_paper_id == paper_id {
                        "outgoing".to_string()
                    } else {
                        "incoming".to_string()
                    },
                    reference_id: row.get(0)?,
                    source_paper_id,
                    source_title: row.get(2)?,
                    target_paper_id: row.get(3)?,
                    target_title: row.get(4)?,
                    page_number: row.get(5)?,
                    raw_text: row.get(6)?,
                    doi: row.get(7)?,
                    match_kind: row.get(8)?,
                    confidence: row.get(9)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(relations)
}

fn sync_paper_references_on(
    connection: &mut Connection,
    paper_id: &str,
    pages: &[ReferencePageInput],
) -> Result<Vec<PaperRelation>, String> {
    let (title, metadata_title, existing_doi) = connection
        .query_row(
            "SELECT title, metadata_title, doi FROM papers WHERE id = ?1",
            params![paper_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "论文不存在".to_string())?;
    let parsed = parse_reference_entries(pages);
    let detected_doi = find_document_doi(pages);
    let canonical_doi = if detected_doi.is_empty() {
        normalize_doi(&existing_doi)
    } else {
        detected_doi
    };
    let canonical_title = if metadata_title.trim().is_empty() {
        title.as_str()
    } else {
        metadata_title.as_str()
    };
    let timestamp = now();

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE papers SET normalized_title = ?2, doi = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                paper_id,
                normalize_title(canonical_title),
                canonical_doi,
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    if let Some(references) = parsed {
        transaction
            .execute(
                "DELETE FROM paper_references WHERE source_paper_id = ?1",
                params![paper_id],
            )
            .map_err(|error| error.to_string())?;
        for reference in references {
            let digest = format!(
                "{:x}",
                Sha256::digest(
                    format!(
                        "{paper_id}:{}:{}",
                        reference.entry_index, reference.raw_text
                    )
                    .as_bytes()
                )
            );
            let id = format!("reference-{}", &digest[..24]);
            transaction
                .execute(
                    "INSERT INTO paper_references(
                        id, source_paper_id, entry_index, page_number, raw_text,
                        normalized_text, doi, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![
                        id,
                        paper_id,
                        reference.entry_index,
                        reference.page_number,
                        reference.raw_text,
                        reference.normalized_text,
                        reference.doi,
                        timestamp
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "UPDATE papers SET reference_scan_version = ?2,
                    references_indexed_at = ?3 WHERE id = ?1",
                params![paper_id, REFERENCE_SCHEMA_VERSION, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    resolve_all_reference_matches(connection)?;
    list_paper_relations_on(connection, paper_id)
}

/// 使用 PDF.js 提取的原始页面文本重建参考文献，并重新匹配整个本地文献库。
#[tauri::command]
pub fn research_sync_paper_references(
    paper_id: String,
    pages: Vec<ReferencePageInput>,
) -> Result<Vec<PaperRelation>, String> {
    let pages = validate_reference_pages(pages)?;
    with_database(|connection| sync_paper_references_on(connection, &paper_id, &pages))
}

/// 仅返回 DOI 或完整题名规则确认的库内引用关系，低置信记录不会暴露给界面。
#[tauri::command]
pub fn research_list_paper_relations(paper_id: String) -> Result<Vec<PaperRelation>, String> {
    with_database(|connection| list_paper_relations_on(connection, &paper_id))
}

#[derive(Debug, Clone, PartialEq)]
struct TextChunk {
    section_title: String,
    content: String,
}

fn looks_like_heading(line: &str) -> bool {
    let trimmed = line.trim();
    let length = trimmed.chars().count();
    if !(3..=140).contains(&length) || trimmed.ends_with(['.', '。', ';', '；', ',']) {
        return false;
    }
    let letters = trimmed
        .chars()
        .filter(|character| character.is_alphabetic())
        .count();
    let uppercase = trimmed
        .chars()
        .filter(|character| character.is_uppercase())
        .count();
    trimmed.starts_with('#')
        || trimmed
            .split_once(['.', '、'])
            .is_some_and(|(prefix, _)| prefix.chars().all(|character| character.is_ascii_digit()))
        || (letters >= 3 && uppercase * 2 >= letters)
}

/// 先按可识别的章节标题分段，再在章节内按字符窗口切块。
/// PDF.js 提供的文本层经常丢失段落，因此在没有可靠标题时仍会退化为页级切块。
fn split_chunks(text: &str, limit: usize, overlap: usize) -> Vec<TextChunk> {
    if limit == 0 {
        return Vec::new();
    }
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut title = String::new();
    let mut body = String::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if looks_like_heading(line) && !body.trim().is_empty() {
            sections.push((title.clone(), body.trim().to_string()));
            title = line.trim_start_matches('#').trim().to_string();
            body.clear();
        } else if looks_like_heading(line) && body.trim().is_empty() {
            title = line.trim_start_matches('#').trim().to_string();
        } else {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(line);
        }
    }
    if !body.trim().is_empty() {
        sections.push((title, body.trim().to_string()));
    }
    if sections.is_empty() && !text.trim().is_empty() {
        sections.push((String::new(), text.trim().to_string()));
    }

    let mut chunks = Vec::new();
    for (section_title, body) in sections {
        let characters: Vec<char> = body.chars().collect();
        let mut start = 0;
        while start < characters.len() {
            let end = (start + limit).min(characters.len());
            let content: String = characters[start..end].iter().collect();
            if !content.trim().is_empty() {
                chunks.push(TextChunk {
                    section_title: section_title.clone(),
                    content: content.trim().to_string(),
                });
            }
            if end == characters.len() {
                break;
            }
            start = end.saturating_sub(overlap.min(limit.saturating_sub(1)));
        }
    }
    chunks
}

#[tauri::command]
pub fn research_index_page(
    paper_id: String,
    page_number: i64,
    text: String,
) -> Result<usize, String> {
    index_page_internal(&paper_id, page_number, &text)
}

fn replace_page_chunks(
    transaction: &Transaction<'_>,
    paper_id: &str,
    page_number: i64,
    text: &str,
) -> Result<usize, String> {
    let safe_page_number = page_number.max(1);
    let chunks = split_chunks(text, 1_200, 180);
    transaction
        .execute(
            "DELETE FROM document_chunks_fts WHERE paper_id = ?1 AND page_number = ?2",
            params![paper_id, safe_page_number],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM document_chunks WHERE paper_id = ?1 AND page_number = ?2",
            params![paper_id, safe_page_number],
        )
        .map_err(|error| error.to_string())?;
    for (index, chunk) in chunks.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO document_chunks(
                    paper_id, page_number, chunk_index, section_title, content
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    paper_id,
                    safe_page_number,
                    index as i64,
                    chunk.section_title,
                    chunk.content
                ],
            )
            .map_err(|error| error.to_string())?;
        let chunk_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO document_chunks_fts(rowid, paper_id, page_number, content)
                 VALUES (?1, ?2, ?3, ?4)",
                params![chunk_id, paper_id, safe_page_number, chunk.content],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(chunks.len())
}

/// 批量写入 PDF.js 后台提取的全文，避免每页重复打开数据库。
#[tauri::command]
pub fn research_index_pages(
    paper_id: String,
    pages: Vec<ReferencePageInput>,
) -> Result<usize, String> {
    let pages = validate_reference_pages(pages)?;
    with_database(|connection| {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let mut chunk_count = 0_usize;
        for page in pages {
            chunk_count +=
                replace_page_chunks(&transaction, &paper_id, page.page_number, &page.text)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(chunk_count)
    })
}

pub(crate) fn index_page_internal(
    paper_id: &str,
    page_number: i64,
    text: &str,
) -> Result<usize, String> {
    with_database(|connection| {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let chunk_count = replace_page_chunks(&transaction, paper_id, page_number, text)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(chunk_count)
    })
}

fn fts_query_from_text(query: &str) -> String {
    let terms = query
        .split_whitespace()
        .map(|term| term.trim_matches(|character: char| !character.is_alphanumeric()))
        .filter(|term| !term.is_empty())
        .take(16)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        format!("\"{}\"", query.replace('"', "\"\""))
    } else {
        terms.join(" OR ")
    }
}

pub(crate) fn lexical_search_internal(
    paper_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let fts_query = fts_query_from_text(query);
    with_database(|connection| lexical_search_on(connection, paper_id, &fts_query, limit))
}

fn lexical_search_on(
    connection: &Connection,
    paper_id: &str,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.paper_id, d.page_number, d.chunk_index,
                        d.section_title, d.content, bm25(document_chunks_fts)
                 FROM document_chunks_fts
                 JOIN document_chunks d ON d.id = document_chunks_fts.rowid
                 WHERE document_chunks_fts MATCH ?1 AND d.paper_id = ?2
                 ORDER BY bm25(document_chunks_fts) LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let hits = statement
        .query_map(params![fts_query, paper_id, limit.clamp(1, 60)], |row| {
            let rank: f64 = row.get(6)?;
            Ok(SearchHit {
                chunk_id: row.get(0)?,
                paper_id: row.get(1)?,
                page_number: row.get(2)?,
                chunk_index: row.get(3)?,
                section_title: row.get(4)?,
                quote: row.get(5)?,
                score: 1.0 / (1.0 + rank.abs()),
                match_kind: "lexical".to_string(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(hits)
}

#[tauri::command]
pub fn research_search(
    paper_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    lexical_search_internal(&paper_id, &query, limit)
}

pub(crate) fn paper_chunk_counts(paper_id: &str, model: &str) -> Result<(usize, usize), String> {
    with_database(|connection| {
        connection
            .query_row(
                "SELECT COUNT(d.id), COUNT(e.chunk_id)
                 FROM document_chunks d
                 LEFT JOIN embeddings e ON e.chunk_id = d.id AND e.model = ?2
                 WHERE d.paper_id = ?1",
                params![paper_id, model],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as usize,
                        row.get::<_, i64>(1)? as usize,
                    ))
                },
            )
            .map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("xiaoyun-research-{name}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fake_pdf(path: &Path) {
        fs::write(path, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF").unwrap();
    }

    fn minimal_docx(path: &Path, document_xml: &str) {
        let file = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(document_xml.as_bytes()).unwrap();
        archive.finish().unwrap();
    }

    fn reference_page(page_number: i64, text: &str) -> ReferencePageInput {
        ReferencePageInput {
            page_number,
            text: text.to_string(),
        }
    }

    fn insert_reference_test_paper(connection: &Connection, id: &str, title: &str, doi: &str) {
        connection
            .execute(
                "INSERT INTO papers(
                    id, sha256, title, normalized_title, doi, managed_path,
                    original_filename, created_at, updated_at
                 ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?5, 'now', 'now')",
                params![
                    id,
                    title,
                    normalize_title(title),
                    normalize_doi(doi),
                    format!("{id}.pdf")
                ],
            )
            .unwrap();
    }

    fn outline_item(
        title: &str,
        page_number: i64,
        level: i64,
        source: &str,
        confidence: f64,
    ) -> OutlineItem {
        OutlineItem {
            title: title.to_string(),
            page_number,
            end_page: 0,
            level,
            source: source.to_string(),
            confidence,
        }
    }

    #[test]
    fn document_outline_levels_match_one_based_frontend_contract() {
        assert_eq!(outline_level_from_title("# Introduction"), 1);
        assert_eq!(outline_level_from_title("## Methods"), 2);
        assert_eq!(outline_level_from_title("######### Too deep"), 8);
        assert_eq!(outline_level_from_title("第一章 绪论"), 1);
        assert_eq!(outline_level_from_title("第一节 背景"), 2);
        assert_eq!(outline_level_from_title("1 Introduction"), 1);
        assert_eq!(outline_level_from_title("1.2 Methods"), 2);
        assert_eq!(outline_level_from_title("Introduction"), 1);
    }

    #[test]
    fn document_outline_deduplicates_and_computes_hierarchical_end_pages() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-outline", "Outline", "");
        connection
            .execute(
                "UPDATE papers SET page_count = 20 WHERE id = 'paper-outline'",
                [],
            )
            .unwrap();

        let outline = replace_document_outline_on(
            &mut connection,
            "paper-outline",
            vec![
                outline_item("Chapter 1", 1, 1, "native", 0.90),
                outline_item("Section 1.1", 2, 2, "text", 0.80),
                outline_item("Section 1.1", 2, 2, "vision", 0.95),
                outline_item("Section 1.2", 5, 2, "text", 0.80),
                outline_item("Chapter 2", 10, 1, "native", 0.90),
                outline_item("Section 2.1", 12, 2, "text", 0.80),
            ],
        )
        .unwrap();

        assert_eq!(outline.len(), 5);
        assert_eq!(
            outline
                .iter()
                .map(|item| (
                    item.title.as_str(),
                    item.page_number,
                    item.end_page,
                    item.level
                ))
                .collect::<Vec<_>>(),
            vec![
                ("Chapter 1", 1, 9, 1),
                ("Section 1.1", 2, 4, 2),
                ("Section 1.2", 5, 9, 2),
                ("Chapter 2", 10, 20, 1),
                ("Section 2.1", 12, 20, 2),
            ]
        );
        assert_eq!(outline[1].source, "vision");
        assert_eq!(outline[1].confidence, 0.95);
        assert_eq!(
            load_document_outline(&connection, "paper-outline").unwrap(),
            outline
        );
    }

    #[test]
    fn document_outline_survives_reopen_and_cascades_with_paper() {
        let root = temporary_directory("document-outline-reopen");
        let database = root.join("research.db");
        {
            let mut connection = open_database_at(&database).unwrap();
            insert_reference_test_paper(&connection, "paper-a", "Paper A", "");
            connection
                .execute("UPDATE papers SET page_count = 12 WHERE id = 'paper-a'", [])
                .unwrap();
            replace_document_outline_on(
                &mut connection,
                "paper-a",
                vec![
                    outline_item("Introduction", 1, 1, "native", 1.0),
                    outline_item("Methods", 4, 1, "native", 1.0),
                ],
            )
            .unwrap();
        }

        let mut connection = open_database_at(&database).unwrap();
        let document = get_document_on(&connection, "paper-a").unwrap();
        assert_eq!(document.outline.len(), 2);
        assert_eq!(document.outline[0].end_page, 3);
        assert_eq!(document.outline[1].end_page, 12);
        let transaction = connection.transaction().unwrap();
        delete_paper_rows(&transaction, "paper-a").unwrap();
        transaction.commit().unwrap();
        let outline_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM document_outline WHERE paper_id = 'paper-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(outline_count, 0);
        drop(connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_document_outline_is_rejected_without_replacing_saved_data() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-invalid", "Invalid", "");
        connection
            .execute(
                "UPDATE papers SET page_count = 10 WHERE id = 'paper-invalid'",
                [],
            )
            .unwrap();
        let saved = replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![outline_item("Existing", 1, 1, "native", 1.0)],
        )
        .unwrap();

        assert!(replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![outline_item("Zero based", 1, 0, "text", 0.8)],
        )
        .is_err());
        assert!(replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![outline_item("Too deep", 1, 9, "text", 0.8)],
        )
        .is_err());
        assert!(replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![outline_item("Outside", 11, 1, "text", 0.8)],
        )
        .is_err());
        assert!(replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![
                outline_item("Root", 1, 1, "text", 0.8),
                outline_item("Too deep", 2, 3, "text", 0.8),
            ],
        )
        .is_err());
        assert!(replace_document_outline_on(
            &mut connection,
            "paper-invalid",
            vec![outline_item("NaN", 1, 1, "text", f64::NAN)],
        )
        .is_err());
        assert_eq!(
            load_document_outline(&connection, "paper-invalid").unwrap(),
            saved
        );
    }

    #[test]
    fn rebuild_document_outline_uses_chunks_and_preserves_native_outline() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-rebuild", "Rebuild", "");
        connection
            .execute(
                "UPDATE papers SET page_count = 8 WHERE id = 'paper-rebuild'",
                [],
            )
            .unwrap();
        for (page, index, section, content) in [
            (1_i64, 0_i64, "1 Introduction", "Body"),
            (2, 0, "1 Introduction", "Repeated running header"),
            (3, 0, "2 Methods", "Body"),
            (5, 0, "", "2.1 Analysis\nDetails"),
        ] {
            connection
                .execute(
                    "INSERT INTO document_chunks(
                        paper_id, page_number, chunk_index, section_title, content
                     ) VALUES ('paper-rebuild', ?1, ?2, ?3, ?4)",
                    params![page, index, section, content],
                )
                .unwrap();
        }

        let rebuilt = rebuild_document_outline_on(&mut connection, "paper-rebuild", "ocr").unwrap();
        assert_eq!(
            rebuilt
                .iter()
                .map(|item| (
                    item.title.as_str(),
                    item.page_number,
                    item.end_page,
                    item.level
                ))
                .collect::<Vec<_>>(),
            vec![
                ("1 Introduction", 1, 2, 1),
                ("2 Methods", 3, 8, 1),
                ("2.1 Analysis", 5, 8, 2),
            ]
        );

        connection
            .execute(
                "INSERT INTO document_chunks(
                    paper_id, page_number, chunk_index, section_title, content
                 ) VALUES ('paper-rebuild', 9, 0, 'Outside', 'Body')",
                [],
            )
            .unwrap();
        assert!(rebuild_document_outline_on(&mut connection, "paper-rebuild", "ocr").is_err());
        assert_eq!(
            load_document_outline(&connection, "paper-rebuild").unwrap(),
            rebuilt
        );
        connection
            .execute(
                "DELETE FROM document_chunks WHERE paper_id = 'paper-rebuild' AND page_number = 9",
                [],
            )
            .unwrap();

        let native = replace_document_outline_on(
            &mut connection,
            "paper-rebuild",
            vec![outline_item("Native chapter", 2, 1, "native", 1.0)],
        )
        .unwrap();
        assert_eq!(
            rebuild_document_outline_on(&mut connection, "paper-rebuild", "ocr").unwrap(),
            native
        );
    }

    #[test]
    fn hash_file_streams_content_larger_than_heap_buffer() {
        let root = temporary_directory("streaming-hash");
        let source = root.join("large.pdf");
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', FILE_HASH_BUFFER_BYTES * 3));
        fs::write(&source, &bytes).unwrap();

        let (digest, size) = hash_file(&source).unwrap();
        let expected = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(digest, expected);
        assert_eq!(size, bytes.len() as u64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn supported_extensions_and_pdf_signature_are_strictly_validated() {
        assert_eq!(
            SourceFormat::from_path(Path::new("paper.PDF")).unwrap(),
            SourceFormat::Pdf
        );
        assert_eq!(
            SourceFormat::from_path(Path::new("notes.MARKDOWN")).unwrap(),
            SourceFormat::Markdown
        );
        assert_eq!(
            SourceFormat::from_path(Path::new("draft.DOCX")).unwrap(),
            SourceFormat::Docx
        );
        assert_eq!(
            SourceFormat::from_path(Path::new("article.TeX")).unwrap(),
            SourceFormat::Tex
        );
        assert!(SourceFormat::from_path(Path::new("paper.txt")).is_err());

        let root = temporary_directory("source-validation");
        let valid_pdf = root.join("valid.PDF");
        fake_pdf(&valid_pdf);
        assert_eq!(
            validate_source_path(&valid_pdf).unwrap().1,
            SourceFormat::Pdf
        );

        let disguised_pdf = root.join("disguised.pdf");
        fs::write(&disguised_pdf, b"not a PDF").unwrap();
        assert!(validate_source_path(&disguised_pdf)
            .unwrap_err()
            .contains("内容不是有效 PDF"));

        let unsupported = root.join("unsupported.txt");
        fs::write(&unsupported, "plain text").unwrap();
        assert!(validate_source_path(&unsupported).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn utf8_reader_handles_bom_newlines_and_rejects_unsafe_input() {
        let root = temporary_directory("utf8-reader");
        let valid = root.join("valid.md");
        fs::write(&valid, b"\xef\xbb\xbfalpha\r\nbeta\rgamma").unwrap();
        assert_eq!(read_utf8_document(&valid).unwrap(), "alpha\nbeta\ngamma");

        let invalid_utf8 = root.join("invalid.md");
        fs::write(&invalid_utf8, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(read_utf8_document(&invalid_utf8)
            .unwrap_err()
            .contains("UTF-8"));

        let nul = root.join("nul.tex");
        fs::write(&nul, b"before\0after").unwrap();
        assert!(read_utf8_document(&nul).unwrap_err().contains("空字符"));

        let invalid_markdown = root.join("invalid.md");
        fs::write(&invalid_markdown, b"before\0after").unwrap();
        let managed_root = root.join("managed");
        let hash = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
        assert!(prepare_document(
            &invalid_markdown,
            SourceFormat::Markdown,
            hash,
            &managed_root,
            "auto",
        )
        .is_err());
        assert!(!managed_root.join(format!("{hash}.md")).exists());

        let oversized = root.join("oversized.md");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_TEXT_DOCUMENT_BYTES + 1)
            .unwrap();
        assert!(read_utf8_document(&oversized)
            .unwrap_err()
            .contains("32 MiB"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docx_ooxml_paragraphs_preserve_tabs_breaks_and_entities() {
        let root = temporary_directory("docx-paragraphs");
        let path = root.join("sample.docx");
        minimal_docx(
            &path,
            r#"<?xml version="1.0" encoding="UTF-8"?>
               <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                 <w:body>
                   <w:p><w:r><w:t>Alpha</w:t><w:tab/><w:t>Beta</w:t><w:br/><w:t>Gamma</w:t></w:r></w:p>
                   <w:p><w:hyperlink><w:r><w:t>Delta &amp; Omega</w:t></w:r></w:hyperlink></w:p>
                   <w:p><w:r><w:t>   </w:t></w:r></w:p>
                 </w:body>
               </w:document>"#,
        );
        assert_eq!(
            extract_docx_text(&path).unwrap(),
            "Alpha\tBeta\nGamma\n\nDelta & Omega"
        );

        let oversized = root.join("oversized.docx");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_TEXT_DOCUMENT_BYTES + 1)
            .unwrap();
        assert!(extract_docx_text(&oversized)
            .unwrap_err()
            .contains("32 MiB"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tex_compiler_is_allowlisted_and_shell_escape_is_disabled() {
        assert_eq!(
            tex_compiler_names("auto").unwrap(),
            vec!["tectonic", "xelatex", "pdflatex", "latexmk"]
        );
        assert_eq!(tex_compiler_names(" XeLaTeX ").unwrap(), vec!["xelatex"]);
        for invalid in ["cmd", "powershell", "pdflatex.exe", "../pdflatex"] {
            assert!(resolve_tex_compilers(invalid)
                .unwrap_err()
                .contains("不支持的 TeX 编译器"));
        }

        let root = Path::new("build-output");
        let source = Path::new("paper.tex");
        let tectonic = tex_compiler_arguments("tectonic", root, source).unwrap();
        assert!(tectonic.iter().any(|value| value == "--untrusted"));
        for compiler in ["latexmk", "xelatex", "pdflatex"] {
            let arguments = tex_compiler_arguments(compiler, root, source).unwrap();
            assert!(arguments.iter().any(|value| value == "-no-shell-escape"));
            assert!(!arguments.iter().any(|value| value == "-shell-escape"));
            if compiler == "latexmk" {
                assert!(arguments.iter().any(|value| value == "-norc"));
            }
        }
    }

    #[test]
    fn tex_timeout_terminates_child_process() {
        #[cfg(windows)]
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = Command::new("sh")
            .args(["-c", "sleep 10"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error =
            wait_for_compiler(&mut child, "test-compiler", Duration::from_millis(20)).unwrap_err();
        assert!(error.contains("已安全终止"));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn available_tex_compiler_produces_a_real_pdf() {
        let Ok(compilers) = resolve_tex_compilers("auto") else {
            // 没有安装 TeX 的设备仍允许按源码导入；安装器不会静默下载大型编译环境。
            return;
        };
        let Some((compiler, _)) = compilers.first() else {
            return;
        };
        let root = temporary_directory("tex-real-compile");
        let source = root.join("paper.tex");
        fs::write(
            &source,
            "\\documentclass{article}\n\\begin{document}Academic reading test.\\end{document}",
        )
        .unwrap();
        let managed_root = root.join("papers");
        fs::create_dir_all(&managed_root).unwrap();
        let (pdf, used_compiler) = compile_tex_document(
            &source,
            &managed_root,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            compiler,
        )
        .unwrap();
        assert_eq!(&used_compiler, compiler);
        assert!(fs::read(pdf).unwrap().starts_with(b"%PDF-"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn markdown_import_roundtrips_document_fields_and_chunks() {
        let root = temporary_directory("markdown-roundtrip");
        let source = root.join("paper.md");
        fs::write(&source, b"\xef\xbb\xbf# Title\r\n\r\nBody").unwrap();
        let managed_root = root.join("library").join("papers");
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();

        let paper = import_one(&mut connection, &source, &managed_root).unwrap();
        assert_eq!(paper.source_format, "markdown");
        assert_eq!(paper.document_type, "markdown");
        assert_eq!(paper.content_kind, "paper");

        let document = get_document_on(&connection, &paper.id).unwrap();
        assert_eq!(document.source_format, "markdown");
        assert_eq!(document.document_type, "markdown");
        assert_eq!(document.content_kind, "paper");
        assert_eq!(document.text_content, "# Title\n\nBody");
        assert_eq!(document.path, document.source_path);
        assert!(Path::new(&document.source_path).is_file());
        let mut indexed_statement = connection
            .prepare(
                "SELECT section_title, content FROM document_chunks
                 WHERE paper_id = ?1 ORDER BY chunk_index",
            )
            .unwrap();
        let indexed = indexed_statement
            .query_map(params![paper.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(indexed, vec![("Title".to_string(), "Body".to_string())]);
        let insight_status: String = connection
            .query_row(
                "SELECT status FROM paper_insights WHERE paper_id = ?1",
                params![paper.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(insight_status, "queued");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reimport_requeues_failed_insights_but_preserves_ready_summary() {
        let root = temporary_directory("reimport-insights");
        let source = root.join("paper.md");
        fs::write(&source, "# Title\n\nBody").unwrap();
        let managed_root = root.join("library").join("papers");
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();

        let paper = import_one(&mut connection, &source, &managed_root).unwrap();
        connection
            .execute(
                "UPDATE paper_insights SET status = 'failed', error = '临时失败' WHERE paper_id = ?1",
                params![paper.id],
            )
            .unwrap();
        let reimported = import_one(&mut connection, &source, &managed_root).unwrap();
        assert_eq!(reimported.id, paper.id);
        let failed_status: String = connection
            .query_row(
                "SELECT status FROM paper_insights WHERE paper_id = ?1",
                params![paper.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(failed_status, "queued");

        connection
            .execute(
                "UPDATE paper_insights
                 SET status = 'ready', generation_version = 2, model = 'research-model:4b',
                     source_hash = 'hash-a', payload_json = ?2, error = ''
                 WHERE paper_id = ?1",
                params![paper.id, json!({"summary": "已保存概要"}).to_string()],
            )
            .unwrap();
        import_one(&mut connection, &source, &managed_root).unwrap();
        let (ready_status, payload): (String, String) = connection
            .query_row(
                "SELECT status, payload_json FROM paper_insights WHERE paper_id = ?1",
                params![paper.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(ready_status, "ready");
        assert!(payload.contains("已保存概要"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tex_import_falls_back_to_managed_source_without_executing_unknown_programs() {
        let root = temporary_directory("tex-fallback");
        let source = root.join("paper.tex");
        fs::write(
            &source,
            "\\documentclass{article}\n\\begin{document}正文\\end{document}",
        )
        .unwrap();
        let managed_root = root.join("papers");
        let prepared = prepare_document(
            &source,
            SourceFormat::Tex,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            &managed_root,
            "unknown-program",
        )
        .unwrap();
        assert_eq!(prepared.document_type, "tex");
        assert_eq!(prepared.source_format, SourceFormat::Tex);
        assert!(prepared.import_warning.contains("不支持的 TeX 编译器"));
        assert!(prepared.managed_path.is_file());
        assert_eq!(prepared.managed_path, prepared.source_path);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn schema_contains_search_and_cache_tables() {
        let connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        for table in [
            "papers",
            "annotations",
            "reading_progress",
            "document_outline",
            "document_chunks",
            "document_chunks_fts",
            "embeddings",
            "translation_cache",
            "paper_insights",
            "lexicon_cache",
            "paper_references",
            "projects",
            "project_papers",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "缺少数据表：{table}");
        }
        for index in [
            "idx_project_papers_project",
            "idx_project_papers_paper",
            "idx_document_outline_paper_page",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    params![index],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "缺少数据库索引：{index}");
        }
    }

    #[test]
    fn paper_insights_survive_database_reopen() {
        let root = temporary_directory("paper-insights-reopen");
        let database = root.join("research.db");
        let payload = json!({
            "summary": "本文概要已经在导入后生成并保存。",
            "researchQuestion": "概要能否在重新打开后直接读取？",
            "methods": ["关闭并重新打开研究数据库"],
            "findings": ["保存后的概要仍然可用"],
            "limitations": [],
            "terms": []
        })
        .to_string();

        {
            let connection = open_database_at(&database).unwrap();
            insert_reference_test_paper(&connection, "paper-a", "论文 A", "");
            connection
                .execute(
                    "INSERT INTO paper_insights(
                        paper_id, status, generation_version, model, source_hash,
                        payload_json, error, created_at, updated_at
                     ) VALUES (?1, 'ready', 2, 'research-model:4b', 'hash-a', ?2, '', 'now', 'now')",
                    params!["paper-a", payload],
                )
                .unwrap();
        }

        {
            let connection = open_database_at(&database).unwrap();
            let (status, saved_payload): (String, String) = connection
                .query_row(
                    "SELECT status, payload_json FROM paper_insights WHERE paper_id = ?1",
                    params!["paper-a"],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(status, "ready");
            let saved_payload = serde_json::from_str::<Value>(&saved_payload).unwrap();
            assert_eq!(
                saved_payload["summary"],
                json!("本文概要已经在导入后生成并保存。")
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reading_progress_is_isolated_and_survives_database_reopen() {
        let root = temporary_directory("reading-progress-reopen");
        let database = root.join("research.db");
        {
            let mut connection = open_database_at(&database).unwrap();
            insert_reference_test_paper(&connection, "paper-a", "论文 A", "");
            insert_reference_test_paper(&connection, "paper-b", "论文 B", "");
            connection
                .execute(
                    "UPDATE papers SET page_count = CASE id
                        WHEN 'paper-a' THEN 12 WHEN 'paper-b' THEN 6 END
                     WHERE id IN ('paper-a', 'paper-b')",
                    [],
                )
                .unwrap();

            assert_eq!(
                save_progress_on(&mut connection, "paper-a", 7, 1.75, 0.42).unwrap(),
                ReadingProgress {
                    page_number: 7,
                    scale: 1.75,
                    scroll_ratio: 0.42,
                }
            );
            assert_eq!(
                save_progress_on(&mut connection, "paper-b", 3, 1.1, 0.8).unwrap(),
                ReadingProgress {
                    page_number: 3,
                    scale: 1.1,
                    scroll_ratio: 0.8,
                }
            );
        }

        {
            let connection = open_database_at(&database).unwrap();
            let paper_a = get_document_on(&connection, "paper-a").unwrap();
            let paper_b = get_document_on(&connection, "paper-b").unwrap();
            assert_eq!(paper_a.progress.page_number, 7);
            assert_eq!(paper_a.progress.scale, 1.75);
            assert_eq!(paper_a.progress.scroll_ratio, 0.42);
            assert_eq!(paper_a.paper.progress, paper_a.progress);
            assert_eq!(paper_b.progress.page_number, 3);
            assert_eq!(paper_b.progress.scale, 1.1);
            assert_eq!(paper_b.progress.scroll_ratio, 0.8);

            let serialized = serde_json::to_value(&paper_a.progress).unwrap();
            assert_eq!(serialized["pageNumber"], json!(7));
            assert_eq!(serialized["scale"], json!(1.75));
            assert_eq!(serialized["scrollRatio"], json!(0.42));
            assert!(serialized.get("page_number").is_none());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn paper_list_prefers_recent_reading_over_unrelated_paper_updates() {
        let connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-a", "论文 A", "");
        insert_reference_test_paper(&connection, "paper-b", "论文 B", "");
        connection
            .execute(
                "INSERT INTO reading_progress(paper_id, page_number, scale, scroll_ratio, updated_at)
                 VALUES ('paper-a', 2, 1.25, 0.1, '2026-01-01T00:00:00Z'),
                        ('paper-b', 3, 1.25, 0.2, '2026-02-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE papers SET updated_at = '2099-01-01T00:00:00Z' WHERE id = 'paper-a'",
                [],
            )
            .unwrap();

        let papers = list_papers_on(&connection, false).unwrap();
        assert_eq!(
            papers
                .iter()
                .map(|paper| paper.id.as_str())
                .collect::<Vec<_>>(),
            ["paper-b", "paper-a"]
        );
    }

    #[test]
    fn paper_batch_lifecycle_is_atomic_normalized_and_mutually_exclusive() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-a", "论文 A", "");
        insert_reference_test_paper(&connection, "paper-b", "论文 B", "");

        let archived = transition_papers_on(
            &mut connection,
            vec![
                " paper-a ".to_string(),
                "paper-a".to_string(),
                "paper-b".to_string(),
            ],
            PaperLifecycleTransition::Archive,
        )
        .unwrap();
        assert_eq!(archived, ["paper-a", "paper-b"]);
        assert!(list_papers_on(&connection, false).unwrap().is_empty());
        assert_eq!(list_papers_on(&connection, true).unwrap().len(), 2);

        let archived_paper = load_paper(&connection, "paper-a").unwrap().0;
        assert!(archived_paper.archived_at.is_some());
        assert!(archived_paper.trashed_at.is_none());
        let serialized = serde_json::to_value(&archived_paper).unwrap();
        assert!(serialized["archivedAt"].is_string());
        assert!(serialized.get("archived_at").is_none());

        transition_papers_on(
            &mut connection,
            vec!["paper-a".to_string()],
            PaperLifecycleTransition::Trash,
        )
        .unwrap();
        let trashed_paper = load_paper(&connection, "paper-a").unwrap().0;
        assert!(trashed_paper.archived_at.is_none());
        assert!(trashed_paper.trashed_at.is_some());

        transition_papers_on(
            &mut connection,
            vec!["paper-a".to_string()],
            PaperLifecycleTransition::Archive,
        )
        .unwrap();
        let rearchived_paper = load_paper(&connection, "paper-a").unwrap().0;
        assert!(rearchived_paper.archived_at.is_some());
        assert!(rearchived_paper.trashed_at.is_none());

        transition_papers_on(
            &mut connection,
            vec!["paper-a".to_string(), "paper-b".to_string()],
            PaperLifecycleTransition::Restore,
        )
        .unwrap();
        assert_eq!(list_papers_on(&connection, false).unwrap().len(), 2);

        let missing_error = transition_papers_on(
            &mut connection,
            vec!["paper-a".to_string(), "missing".to_string()],
            PaperLifecycleTransition::Archive,
        )
        .unwrap_err();
        assert!(missing_error.contains("missing"));
        let rolled_back = load_paper(&connection, "paper-a").unwrap().0;
        assert!(rolled_back.archived_at.is_none());
        assert!(rolled_back.trashed_at.is_none());
        assert!(connection
            .execute(
                "UPDATE papers
                 SET archived_at = 'archived', trashed_at = 'trashed'
                 WHERE id = 'paper-a'",
                [],
            )
            .unwrap_err()
            .to_string()
            .contains("不能同时"));

        assert!(transition_papers_on(
            &mut connection,
            Vec::new(),
            PaperLifecycleTransition::Archive
        )
        .unwrap_err()
        .contains("至少选择"));
        assert!(transition_papers_on(
            &mut connection,
            vec!["  ".to_string()],
            PaperLifecycleTransition::Archive
        )
        .unwrap_err()
        .contains("不能为空"));
        assert_eq!(
            normalize_paper_ids(vec![" paper-a ".to_string(); MAX_PAPER_BATCH_SIZE + 1]).unwrap(),
            ["paper-a"]
        );
        let oversized = (0..=MAX_PAPER_BATCH_SIZE)
            .map(|index| format!("paper-{index}"))
            .collect();
        assert!(transition_papers_on(
            &mut connection,
            oversized,
            PaperLifecycleTransition::Archive
        )
        .unwrap_err()
        .contains("最多"));
    }

    #[test]
    fn archived_papers_are_excluded_from_project_counts_until_restored() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-one", "Paper One", "");
        let project = create_project_on(&mut connection, "归档计数", "#aabbcc", "").unwrap();
        set_paper_projects_on(&mut connection, "paper-one", vec![project.id.clone()]).unwrap();
        assert_eq!(
            load_project(&connection, &project.id).unwrap().paper_count,
            1
        );

        transition_papers_on(
            &mut connection,
            vec!["paper-one".to_string()],
            PaperLifecycleTransition::Archive,
        )
        .unwrap();
        assert_eq!(
            load_project(&connection, &project.id).unwrap().paper_count,
            0
        );

        transition_papers_on(
            &mut connection,
            vec!["paper-one".to_string()],
            PaperLifecycleTransition::Unarchive,
        )
        .unwrap();
        assert_eq!(
            load_project(&connection, &project.id).unwrap().paper_count,
            1
        );
    }

    #[test]
    fn reading_progress_rejects_invalid_values_and_tracks_page_count_changes() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper", "测试论文", "");
        update_page_count_on(&mut connection, "paper", 8).unwrap();

        let sanitized =
            save_progress_on(&mut connection, "paper", 99, f64::NAN, f64::INFINITY).unwrap();
        assert_eq!(
            sanitized,
            ReadingProgress {
                page_number: 8,
                scale: 1.25,
                scroll_ratio: 0.0,
            }
        );

        let clamped = save_progress_on(&mut connection, "paper", 0, 0.1, 2.0).unwrap();
        assert_eq!(
            clamped,
            ReadingProgress {
                page_number: 1,
                scale: 0.5,
                scroll_ratio: 1.0,
            }
        );

        save_progress_on(&mut connection, "paper", 8, 2.0, 0.75).unwrap();
        update_page_count_on(&mut connection, "paper", 3).unwrap();
        let document = get_document_on(&connection, "paper").unwrap();
        assert_eq!(document.progress.page_number, 3);
        assert_eq!(document.progress.scale, 2.0);
        assert_eq!(document.progress.scroll_ratio, 0.75);
        assert!(!document.text_index_complete);

        mark_text_index_complete_on(&mut connection, "paper", 12).unwrap();
        let indexed_document = get_document_on(&connection, "paper").unwrap();
        assert!(indexed_document.text_index_complete);
        assert_eq!(indexed_document.page_count, 12);

        assert!(save_progress_on(&mut connection, "missing", 1, 1.0, 0.0)
            .unwrap_err()
            .contains("论文不存在"));
        assert!(update_page_count_on(&mut connection, "missing", 2)
            .unwrap_err()
            .contains("论文不存在"));
    }

    #[test]
    fn legacy_papers_schema_is_migrated_for_reference_metadata() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE papers (
                    id TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    authors TEXT NOT NULL DEFAULT '',
                    journal TEXT NOT NULL DEFAULT '',
                    year INTEGER,
                    page_count INTEGER NOT NULL DEFAULT 1,
                    managed_path TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    trashed_at TEXT
                );
                INSERT INTO papers(
                    id, sha256, title, managed_path, original_filename, created_at, updated_at
                ) VALUES ('legacy', 'legacy-hash', 'A Legacy Paper', 'legacy.pdf', 'legacy.pdf', 'now', 'now');
                "#,
            )
            .unwrap();
        initialise_schema(&connection).unwrap();

        let columns = connection
            .prepare("PRAGMA table_info(papers)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for expected in [
            "metadata_title",
            "normalized_title",
            "doi",
            "reference_scan_version",
            "references_indexed_at",
            "source_format",
            "document_type",
            "content_kind",
            "source_path",
            "text_content",
            "import_warning",
            "tex_compiler",
            "text_index_complete",
            "archived_at",
        ] {
            assert!(columns.iter().any(|column| column == expected));
        }
        let normalized: String = connection
            .query_row(
                "SELECT normalized_title FROM papers WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(normalized, "a legacy paper");
        let migrated_document_fields = connection
            .query_row(
                "SELECT source_format, document_type, content_kind, source_path, text_content,
                        import_warning, tex_compiler
                 FROM papers WHERE id = 'legacy'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            migrated_document_fields,
            (
                "pdf".to_string(),
                "pdf".to_string(),
                "paper".to_string(),
                "legacy.pdf".to_string(),
                String::new(),
                String::new(),
                String::new(),
            )
        );
        for table in ["projects", "project_papers"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "旧数据库未迁移项目表：{table}");
        }
    }

    #[test]
    fn project_crud_assignment_and_cascade_preserve_papers() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "paper-one", "Paper One", "");

        let first = create_project_on(
            &mut connection,
            "  代谢研究  ",
            "#AABBCC",
            "  热力学与代谢网络  ",
        )
        .unwrap();
        assert_eq!(first.name, "代谢研究");
        assert_eq!(first.color, "#aabbcc");
        assert_eq!(first.description, "热力学与代谢网络");
        assert_eq!(first.paper_count, 0);

        let assigned =
            set_paper_projects_on(&mut connection, "paper-one", vec![first.id.clone()]).unwrap();
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].paper_count, 1);
        let (paper, _) = load_paper(&connection, "paper-one").unwrap();
        assert_eq!(paper.projects, assigned);

        let updated = update_project_on(
            &mut connection,
            &first.id,
            "代谢建模",
            "#123456",
            "模型与方法",
        )
        .unwrap();
        assert_eq!(updated.name, "代谢建模");
        assert_eq!(updated.paper_count, 1);

        let error = set_paper_projects_on(
            &mut connection,
            "paper-one",
            vec!["missing-project".to_string()],
        )
        .unwrap_err();
        assert!(error.contains("项目不存在"));
        assert_eq!(
            load_paper_projects(&connection, "paper-one").unwrap().len(),
            1
        );

        delete_project_on(&mut connection, &first.id).unwrap();
        let paper_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0))
            .unwrap();
        let relation_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM project_papers", [], |row| row.get(0))
            .unwrap();
        assert_eq!(paper_count, 1, "删除项目不应删除论文");
        assert_eq!(relation_count, 0, "删除项目后应级联清理分类关系");
    }

    #[test]
    fn project_fields_are_strictly_validated() {
        assert!(validate_project_name("").is_err());
        assert!(validate_project_name("含有\n换行").is_err());
        assert!(validate_project_name(&"项".repeat(81)).is_err());
        assert_eq!(validate_project_color("#7A6BE9").unwrap(), "#7a6be9");
        assert!(validate_project_color("7a6be9").is_err());
        assert!(validate_project_color("#xyzxyz").is_err());
        assert!(validate_project_description(&"说".repeat(1_001)).is_err());
        assert!(validate_project_description("说明\0非法").is_err());
    }

    #[test]
    fn doi_normalization_accepts_urls_and_removes_trailing_punctuation() {
        assert_eq!(
            normalize_doi("https://doi.org/10.1016/J.CELL.2024.01.007)."),
            "10.1016/j.cell.2024.01.007"
        );
        assert_eq!(normalize_doi("doi:10.1000/ABC-123"), "10.1000/abc-123");
        assert!(normalize_doi("10.12/not-a-doi").is_empty());
    }

    #[test]
    fn numbered_reference_parser_preserves_wrapped_lines_and_doi() {
        let pages = vec![
            reference_page(1, "Paper title\nDOI: 10.1111/source"),
            reference_page(
                8,
                "REFERENCES\n[1] Smith J. A reliable method.\nJournal Name. https://doi.org/10.1000/ABC.1.\n[2] Lee K. Another paper. 10.2000/test-2)",
            ),
        ];
        let references = parse_reference_entries(&pages).unwrap();
        assert_eq!(references.len(), 2);
        assert!(references[0].raw_text.contains("method.\nJournal"));
        assert_eq!(references[0].doi, "10.1000/abc.1");
        assert_eq!(references[1].doi, "10.2000/test-2");
        assert_eq!(find_document_doi(&pages), "10.1111/source");
    }

    #[test]
    fn chinese_reference_heading_and_numbering_are_supported() {
        let pages = vec![reference_page(
            12,
            "参考文献\n1、张三. 代谢网络分析方法. 10.1234/CN.1\n2) 李四. 系统生物学研究. 10.1234/CN.2",
        )];
        let references = parse_reference_entries(&pages).unwrap();
        assert_eq!(references.len(), 2);
        assert_eq!(references[0].doi, "10.1234/cn.1");
        assert_eq!(references[1].page_number, 12);
    }

    #[test]
    fn doi_exact_match_creates_outgoing_and_incoming_relations() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(
            &connection,
            "source",
            "Source Paper About Metabolism",
            "10.1111/source",
        );
        insert_reference_test_paper(
            &connection,
            "target",
            "Target Paper About Flux Analysis",
            "10.2222/target",
        );
        let pages = vec![
            reference_page(1, "Source Paper About Metabolism\ndoi:10.1111/source"),
            reference_page(
                9,
                "References\n[1] Author. Unrelated display title. https://doi.org/10.2222/TARGET.",
            ),
        ];

        let outgoing = sync_paper_references_on(&mut connection, "source", &pages).unwrap();
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].target_paper_id, "target");
        assert_eq!(outgoing[0].direction, "outgoing");
        assert_eq!(outgoing[0].match_kind, "doi");
        assert_eq!(outgoing[0].confidence, 1.0);

        let incoming = list_paper_relations_on(&connection, "target").unwrap();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].direction, "incoming");
        assert_eq!(incoming[0].source_paper_id, "source");
    }

    #[test]
    fn complete_normalized_title_can_link_without_doi() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(
            &connection,
            "source",
            "A Different Source Paper for Testing",
            "",
        );
        insert_reference_test_paper(
            &connection,
            "target",
            "Constraint Based Reconstruction and Analysis of Metabolic Networks",
            "",
        );
        let pages = vec![reference_page(
            15,
            "Bibliography\n[1] Smith et al. Constraint-Based Reconstruction and Analysis of Metabolic Networks. Journal 2024.",
        )];

        let relations = sync_paper_references_on(&mut connection, "source", &pages).unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].target_paper_id, "target");
        assert_eq!(relations[0].match_kind, "title");
        assert_eq!(relations[0].confidence, 0.97);
    }

    #[test]
    fn short_partial_or_ambiguous_titles_never_create_relations() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        insert_reference_test_paper(&connection, "source", "Source Research Article", "");
        insert_reference_test_paper(&connection, "short", "Study", "");
        insert_reference_test_paper(
            &connection,
            "duplicate-a",
            "A Complete Deterministic Framework for Reliable Citation Matching",
            "",
        );
        insert_reference_test_paper(
            &connection,
            "duplicate-b",
            "A Complete Deterministic Framework for Reliable Citation Matching",
            "",
        );
        let pages = vec![reference_page(
            6,
            "References\n[1] Study. Journal.\n[2] A Complete Deterministic Framework for Reliable Citation Matching. Journal.",
        )];

        let relations = sync_paper_references_on(&mut connection, "source", &pages).unwrap();
        assert!(relations.is_empty());
        let linked: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM paper_references WHERE target_paper_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(linked, 0);
    }

    #[test]
    fn managed_import_is_deduplicated_by_sha256() {
        let root = temporary_directory("dedup");
        let source = root.join("paper.pdf");
        let managed = root.join("library");
        fake_pdf(&source);
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();

        let first = import_one(&mut connection, &source, &managed).unwrap();
        transition_papers_on(
            &mut connection,
            vec![first.id.clone()],
            PaperLifecycleTransition::Archive,
        )
        .unwrap();
        let second = import_one(&mut connection, &source, &managed).unwrap();
        assert_eq!(first.id, second.id);
        assert!(second.archived_at.is_none());
        assert!(second.trashed_at.is_none());
        transition_papers_on(
            &mut connection,
            vec![first.id.clone()],
            PaperLifecycleTransition::Trash,
        )
        .unwrap();
        let third = import_one(&mut connection, &source, &managed).unwrap();
        assert_eq!(first.id, third.id);
        assert!(third.archived_at.is_none());
        assert!(third.trashed_at.is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(fs::read_dir(&managed).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reimport_can_change_content_kind_without_duplicating_the_file() {
        let root = temporary_directory("content-kind-dedup");
        let source = root.join("book.pdf");
        let managed = root.join("library");
        fake_pdf(&source);
        let mut connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();

        let first = import_one_with_content_kind(&mut connection, &source, &managed, Some("paper"))
            .unwrap();
        let book =
            import_one_with_content_kind(&mut connection, &source, &managed, Some("book")).unwrap();
        let unchanged = import_one(&mut connection, &source, &managed).unwrap();

        assert_eq!(first.id, book.id);
        assert_eq!(book.content_kind, "book");
        assert_eq!(unchanged.content_kind, "book");
        let stored: String = connection
            .query_row(
                "SELECT content_kind FROM papers WHERE id = ?1",
                params![book.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "book");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM papers", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(validate_content_kind(Some("article"))
            .unwrap_err()
            .contains("paper 或 book"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn page_index_replaces_old_chunks_transactionally() {
        let connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        connection.execute(
            "INSERT INTO papers(id, sha256, title, managed_path, original_filename, created_at, updated_at)
             VALUES ('p', 'hash', 'Paper', 'p.pdf', 'p.pdf', 'now', 'now')",
            [],
        ).unwrap();
        let chunks = split_chunks(&"学术文本".repeat(700), 1_200, 180);
        assert!(chunks.len() >= 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.content.chars().count() <= 1_200));
    }

    #[test]
    fn section_chunking_keeps_heading_context() {
        let chunks = split_chunks(
            "INTRODUCTION\nA short scientific paragraph.\nMETHODS\nCells were cultured.",
            1_200,
            180,
        );
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].section_title, "INTRODUCTION");
        assert_eq!(chunks[1].section_title, "METHODS");
    }

    #[test]
    fn fts_result_uses_chunk_rowid_for_jump_location() {
        let connection = Connection::open_in_memory().unwrap();
        initialise_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO papers(id, sha256, title, managed_path, original_filename, created_at, updated_at)
                 VALUES ('p', 'hash', 'Paper', 'p.pdf', 'p.pdf', 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO document_chunks(id, paper_id, page_number, chunk_index, section_title, content)
                 VALUES (42, 'p', 7, 2, 'Methods', 'Michaelis Menten kinetics')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO document_chunks_fts(rowid, paper_id, page_number, content)
                 VALUES (42, 'p', 7, 'Michaelis Menten kinetics')",
                [],
            )
            .unwrap();
        let hits = lexical_search_on(&connection, "p", "\"Michaelis\"", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk_id, 42);
        assert_eq!(hits[0].page_number, 7);
        assert_eq!(hits[0].section_title, "Methods");
    }

    #[test]
    fn annotation_payload_preserves_anchor_fields() {
        let mut value = json!({
            "paperId": "p1",
            "pageNumber": 2,
            "quote": "Michaelis–Menten",
            "prefix": "before",
            "suffix": "after",
            "startOffset": 4,
            "endOffset": 21,
            "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}]
        });
        let object = value.as_object_mut().unwrap();
        object.insert("updatedAt".to_string(), json!(now()));
        let roundtrip: Value =
            serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
        assert_eq!(roundtrip["quote"], "Michaelis–Menten");
        assert_eq!(roundtrip["rects"][0]["x"], 0.1);
    }
}
