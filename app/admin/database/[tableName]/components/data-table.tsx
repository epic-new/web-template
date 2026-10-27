"use client";

import * as React from "react";
import { useTable, type ColumnVisibilityState } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TableRow as DataRow } from "../state";
import { CellEditor } from "./cell-editor";
import type { ColumnMetadata } from "../state";
import { dataTableFeatures, type DataTableColumn } from "../table-features";

interface DataTableProps {
  columns: DataTableColumn[];
  data: DataRow[];
  columnMetadata: ColumnMetadata[];
  onCellEdit?: (
    rowId: string | number,
    column: string,
    value: unknown,
  ) => Promise<unknown> | void;
  columnVisibility: Record<string, boolean>;
  onColumnVisibilityChange: (visibility: Record<string, boolean>) => void;
}

export function DataTable({
  columns,
  data,
  columnMetadata,
  onCellEdit,
  columnVisibility,
  onColumnVisibilityChange,
}: DataTableProps) {
  const [editingCell, setEditingCell] = React.useState<{
    rowId: string | number;
    column: string;
  } | null>(null);

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    onColumnVisibilityChange: (updater) => {
      const newValue =
        typeof updater === "function"
          ? updater(columnVisibility as ColumnVisibilityState)
          : updater;
      onColumnVisibilityChange(newValue as Record<string, boolean>);
    },
    state: {
      columnVisibility: columnVisibility as ColumnVisibilityState,
    },
  });

  const handleDoubleClick = (
    rowId: string | number,
    column: string,
    isPrimaryKey: boolean
  ) => {
    if (isPrimaryKey) return; // Don't allow editing primary key
    setEditingCell({ rowId, column });
  };

  const handleSave = async (value: unknown) => {
    if (editingCell && onCellEdit) {
      await onCellEdit(editingCell.rowId, editingCell.column, value);
    }
    setEditingCell(null);
  };

  const handleCancel = () => {
    setEditingCell(null);
  };

  const getColumnType = (columnName: string): string => {
    const col = columnMetadata.find((c) => c.name === columnName);
    return col?.type || "text";
  };

  const isPrimaryKeyColumn = (columnName: string): boolean => {
    const col = columnMetadata.find((c) => c.name === columnName);
    return col?.isPrimaryKey || false;
  };

  return (
    <div className="rounded-lg border overflow-hidden bg-background">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="bg-muted/30 hover:bg-muted/30 border-b">
              {headerGroup.headers.map((header, index) => (
                <TableHead
                  key={header.id}
                  className={`h-10 px-4 text-muted-foreground ${index !== headerGroup.headers.length - 1 ? "border-r border-border/50" : ""}`}
                >
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className={`${row.original._pending ? "opacity-50" : ""} hover:bg-muted/30`}
              >
                {row.getVisibleCells().map((cell, index) => {
                  const columnId = cell.column.id;
                  const rowId = row.original.id as string | number;
                  const isEditing =
                    editingCell?.rowId === rowId &&
                    editingCell?.column === columnId;
                  const isPk = isPrimaryKeyColumn(columnId);
                  const isLastColumn = index === row.getVisibleCells().length - 1;

                  // Skip rendering CellEditor for action columns
                  if (columnId === "actions") {
                    return (
                      <TableCell key={cell.id} className="h-10 px-4 w-[60px]">
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    );
                  }

                  return (
                    <TableCell
                      key={cell.id}
                      onDoubleClick={() =>
                        handleDoubleClick(rowId, columnId, isPk)
                      }
                      className={`h-10 px-4 min-w-[100px] max-w-[250px] ${!isLastColumn ? "border-r border-border/50" : ""} ${!isPk ? "cursor-pointer hover:bg-muted/50" : ""}`}
                    >
                      {isEditing ? (
                        <CellEditor
                          value={cell.getValue()}
                          type={getColumnType(columnId)}
                          onSave={handleSave}
                          onCancel={handleCancel}
                        />
                      ) : (
                        <span className="block truncate text-sm">
                          <table.FlexRender cell={cell} />
                        </span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
