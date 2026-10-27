import { columnVisibilityFeature, tableFeatures, type ColumnDef } from "@tanstack/react-table";

import type { TableRow } from "./state";

/** What the database table uses of TanStack Table: hiding columns, nothing else. */
export const dataTableFeatures = tableFeatures({ columnVisibilityFeature });

export type DataTableColumn = ColumnDef<typeof dataTableFeatures, TableRow>;
