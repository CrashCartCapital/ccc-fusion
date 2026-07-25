import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { PROJECT_SCHEMA } from "./_shared.js";

const cccPrdSchema = pgSchema(PROJECT_SCHEMA);

export const cccPrdImports = cccPrdSchema.table("ccc_prd_imports", {
  projectId: text("project_id").notNull().default(sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`),
  idempotencyKey: text("idempotency_key").notNull(),
  importId: text("import_id").notNull(),
  identityHash: text("identity_hash").notNull(),
  bundleHash: text("bundle_hash").notNull(),
  packetHash: text("packet_hash").notNull(),
  sidecarHash: text("sidecar_hash").notNull(),
  sourceVersion: text("source_version").notNull(),
  targetRepository: text("target_repository").notNull(),
  targetBase: text("target_base").notNull(),
  rootDir: text("root_dir").notNull(),
  stagingRelativePath: text("staging_relative_path").notNull(),
  state: text("state").notNull(),
  runnable: integer("runnable").notNull().default(0),
  canonicalBundle: jsonb("canonical_bundle").notNull(),
  transactionWitness: jsonb("transaction_witness").notNull(),
  projectionDigest: text("projection_digest").notNull(),
  projectionOwner: text("projection_owner"),
  projectionLeaseUntil: text("projection_lease_until"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  activatedAt: text("activated_at"),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.idempotencyKey] }),
  unique("ccc_prd_imports_project_import_unique").on(t.projectId, t.importId),
  index("idx_ccc_prd_imports_state").on(t.projectId, t.state, t.updatedAt),
  index("idx_ccc_prd_imports_identity").on(t.projectId, t.targetRepository, t.targetBase, t.identityHash),
]);

export const cccPrdImportSources = cccPrdSchema.table("ccc_prd_import_sources", {
  projectId: text("project_id").notNull().default(sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`),
  importId: text("import_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  path: text("path").notNull(),
  role: text("role").notNull(),
  authoritative: integer("authoritative").notNull(),
  rawSha256: text("raw_sha256").notNull(),
  byteLength: integer("byte_length").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.importId, t.path] }),
  foreignKey({
    columns: [t.projectId, t.importId],
    foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
  }).onDelete("cascade"),
]);

export const cccPrdImportEntities = cccPrdSchema.table("ccc_prd_import_entities", {
  projectId: text("project_id").notNull().default(sql`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`),
  importId: text("import_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  nativeId: text("native_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  contentDigest: text("content_digest").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.importId, t.entityType, t.entityId] }),
  foreignKey({
    columns: [t.projectId, t.importId],
    foreignColumns: [cccPrdImports.projectId, cccPrdImports.importId],
  }).onDelete("cascade"),
  index("idx_ccc_prd_import_entities_native").on(t.projectId, t.importId, t.entityType, t.nativeId),
]);
