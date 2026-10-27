"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";

import { DataTable } from "./components/data-table";
import { TableToolbar } from "./components/table-toolbar";
import { ColumnHeader } from "./components/column-header";
import { RowActions } from "./components/row-actions";
import { RowFormDialog } from "./components/row-form-dialog";
import { DeleteConfirmation } from "./components/delete-confirmation";
import { Pagination } from "./components/pagination";

import { useViewTable } from "./behaviors/view-table/use-view-table.hook";
import { useAddRow } from "./behaviors/add-row/use-add-row.hook";
import { useEditRow } from "./behaviors/edit-row/use-edit-row.hook";
import { useDeleteRow } from "./behaviors/delete-row/use-delete-row.hook";

import type { TableRow } from "./state";
import type { DataTableColumn } from "./table-features";

export function TableViewContent({
  actorId,
  tableName,
}: {
  actorId: string;
  tableName: string;
}) {
  const {
    rows,
    columns,
    total,
    page,
    totalPages,
    isLoading,
    error,
    sort,
    columnVisibility,
    handleSortChange,
    handleFilterChange,
    handleGoToPage,
    handleRefresh,
    handleColumnVisibilityChange,
    handleToggleColumn,
  } = useViewTable(actorId, tableName);

  const {
    handleAddRow,
    handleOpenDialog: openAddDialog,
    handleCloseDialog: closeAddDialog,
    isDialogOpen: isAddDialogOpen,
    isDuplicate,
    duplicateRow,
    isLoading: isAddLoading,
  } = useAddRow(actorId, tableName);

  const {
    handleEditRow,
    handleEditCell,
    handleOpenDialog: openEditDialog,
    handleCloseDialog: closeEditDialog,
    isDialogOpen: isEditDialogOpen,
    selectedRow: editingRow,
    isLoading: isEditLoading,
  } = useEditRow(actorId, tableName);

  const {
    handleDeleteRow,
    handleOpenDialog: openDeleteDialog,
    handleCloseDialog: closeDeleteDialog,
    isDialogOpen: isDeleteDialogOpen,
    selectedRow: deletingRow,
    isLoading: isDeleteLoading,
  } = useDeleteRow(actorId, tableName);

  // Build column definitions
  const tableColumns: DataTableColumn[] = React.useMemo(() => {
    if (columns.length === 0) return [];

    const cols: DataTableColumn[] = columns.map((col) => ({
      accessorKey: col.name,
      header: () => (
        <ColumnHeader
          column={col.name}
          title={col.name}
          type={col.type}
          sort={sort}
          onSortChange={handleSortChange}
        />
      ),
      cell: ({ row }) => {
        const value = row.getValue(col.name);

        // Show NULL for null/undefined values
        if (value === null || value === undefined) {
          return <span className="text-muted-foreground/50 italic">NULL</span>;
        }

        // Format special types
        if (col.type === "timestamp" && value) {
          return String(value);
        }
        if (col.type === "boolean") {
          return value === 1 || value === true ? "1" : "0";
        }
        if (col.type === "json" && value) {
          const str =
            typeof value === "string" ? value : JSON.stringify(value);
          return str.length > 50 ? str.slice(0, 50) + "..." : str;
        }

        const str = String(value);
        return str.length > 100 ? str.slice(0, 100) + "..." : str;
      },
    }));

    // Add actions column
    cols.push({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <RowActions
          row={row.original}
          onEdit={openEditDialog}
          onDuplicate={(r) => openAddDialog(r)}
          onDelete={openDeleteDialog}
        />
      ),
    });

    return cols;
  }, [
    columns,
    sort,
    handleSortChange,
    openEditDialog,
    openAddDialog,
    openDeleteDialog,
  ]);

  if (error) {
    return (
      <div className="flex-1 p-4">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-4 space-y-4">
      <TableToolbar
        columns={columns}
        onSearch={handleFilterChange}
        onAddRow={() => openAddDialog()}
        onRefresh={handleRefresh}
        isLoading={isLoading}
        columnVisibility={columnVisibility}
        onToggleColumn={handleToggleColumn}
      />

      {isLoading && rows.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          <DataTable
            columns={tableColumns}
            data={rows}
            columnMetadata={columns}
            onCellEdit={handleEditCell}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={handleColumnVisibilityChange}
          />
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onPageChange={handleGoToPage}
          />
        </>
      )}

      <RowFormDialog
        mode="add"
        open={isAddDialogOpen}
        onClose={closeAddDialog}
        columns={columns}
        onSubmit={handleAddRow}
        row={duplicateRow}
        isDuplicate={isDuplicate}
        isLoading={isAddLoading}
      />

      <RowFormDialog
        mode="edit"
        open={isEditDialogOpen}
        onClose={closeEditDialog}
        columns={columns}
        onSubmit={handleEditRow}
        row={editingRow}
        isLoading={isEditLoading}
      />

      <DeleteConfirmation
        open={isDeleteDialogOpen}
        onClose={closeDeleteDialog}
        onConfirm={() => {
          if (deletingRow?.id) {
            void handleDeleteRow(deletingRow.id as string | number).catch(() => {
              // The behavior Hook already exposes and toasts the failure.
            });
          }
        }}
        isLoading={isDeleteLoading}
      />
    </div>
  );
}
