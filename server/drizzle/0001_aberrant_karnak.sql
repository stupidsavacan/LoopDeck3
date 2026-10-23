CREATE UNIQUE INDEX `cloud_revision_operation` ON `cloud_revisions` (`op_id`);--> statement-breakpoint
CREATE INDEX `cloud_revision_object` ON `cloud_revisions` (`object_key`);