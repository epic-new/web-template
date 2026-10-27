"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import type { ColumnMetadata, TableRow } from "../state";

interface RowFormDialogProps {
  mode: "add" | "edit";
  open: boolean;
  onClose: () => void;
  columns: ColumnMetadata[];
  onSubmit: (data: Record<string, unknown>) => Promise<unknown>;
  row?: TableRow | null;
  isDuplicate?: boolean;
  isLoading?: boolean;
}

export function RowFormDialog({
  mode,
  open,
  onClose,
  columns,
  onSubmit,
  row,
  isDuplicate = false,
  isLoading,
}: RowFormDialogProps) {
  const [formData, setFormData] = React.useState<Record<string, unknown>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Determine title and description based on mode
  const title = mode === "add"
    ? (isDuplicate ? "Duplicate Row" : "Add New Row")
    : "Edit Row";

  const description = mode === "add"
    ? (isDuplicate
        ? "Create a copy of the selected row. Modify fields as needed."
        : "Fill in the fields below to create a new row.")
    : "Make changes to the row. Click save when you are done.";

  function initialFormData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (const col of columns) {
      // For add mode, skip auto-generated fields
      if (mode === "add" && (col.isPrimaryKey || col.name === "id")) {
        continue;
      }
      if (mode === "add" && (col.name === "created_at" || col.name === "updated_at")) {
        continue;
      }

      // Get initial value from row (for edit or duplicate)
      const rowValue = row?.[col.name];

      if (mode === "edit" && (col.name === "id" || col.isPrimaryKey)) {
        data[col.name] = rowValue;
      } else if (col.type === "timestamp" && rowValue) {
        // Format timestamp for datetime-local input
        const date = new Date(rowValue as number);
        data[col.name] = date.toISOString().slice(0, 16);
      } else if (col.type === "json" && rowValue) {
        data[col.name] = typeof rowValue === "string"
          ? rowValue
          : JSON.stringify(rowValue, null, 2);
      } else if (col.type === "boolean") {
        data[col.name] = rowValue === 1 || rowValue === true;
      } else if (rowValue !== undefined && rowValue !== null) {
        data[col.name] = rowValue;
      } else if (col.type === "boolean") {
        data[col.name] = false;
      } else {
        data[col.name] = "";
      }
    }
    return data;
  }

  // A fresh form each time the dialog opens, or opens on another row.
  const [openedFor, setOpenedFor] = React.useState<{
    row: typeof row;
    mode: typeof mode;
    columns: typeof columns;
  } | null>(null);
  if (open && (openedFor?.row !== row || openedFor?.mode !== mode || openedFor?.columns !== columns)) {
    setOpenedFor({ row, mode, columns });
    setFormData(initialFormData());
    setErrors({});
  } else if (!open && openedFor) {
    setOpenedFor(null);
  }


  const handleChange = (column: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [column]: value }));
    setErrors((prev) => ({ ...prev, [column]: "" }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Basic validation
    const newErrors: Record<string, string> = {};
    for (const col of columns) {
      if (col.isPrimaryKey || col.name === "id") continue;
      if (col.name === "created_at" || col.name === "updated_at") continue;
      if (!col.isNullable) {
        const value = formData[col.name];
        if (value === "" || value === null || value === undefined) {
          newErrors[col.name] = "This field is required";
        }
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    // Prepare data for submission
    const submitData: Record<string, unknown> = {};
    for (const col of columns) {
      if (col.isPrimaryKey || col.name === "id") continue;
      if (col.name === "created_at" || col.name === "updated_at") continue;

      const value = formData[col.name];
      if (col.type === "boolean") {
        submitData[col.name] = value ? 1 : 0;
      } else if (col.type === "timestamp" && value) {
        submitData[col.name] = new Date(value as string).getTime();
      } else if (col.type === "integer" && value !== "") {
        submitData[col.name] = Number(value);
      } else if (value !== "") {
        submitData[col.name] = value;
      } else {
        submitData[col.name] = null;
      }
    }

    try {
      await onSubmit(submitData);
    } catch {
      // The behavior Hook owns the user-facing error state/toast. Prevent the
      // rejected mutation promise from escaping the form event handler.
    }
  };

  const renderField = (col: ColumnMetadata) => {
    const isReadOnly = col.isPrimaryKey || col.name === "id";
    const isTimestamp = col.name === "created_at" || col.name === "updated_at";

    // In add mode, skip auto-generated fields entirely
    if (mode === "add" && (isReadOnly || isTimestamp)) {
      return null;
    }

    const isRequired = !col.isNullable && !isReadOnly && !isTimestamp;
    const value = formData[col.name];

    // Show timestamps as read-only formatted dates (edit mode only)
    if (isTimestamp) {
      const timestamp = row?.[col.name];
      const formatted = timestamp
        ? new Date(timestamp as number).toLocaleString()
        : "N/A";
      return (
        <div key={col.name} className="space-y-2">
          <Label htmlFor={col.name} className="text-muted-foreground">
            {col.name}
          </Label>
          <Input
            id={col.name}
            value={formatted}
            disabled
            className="bg-muted"
          />
        </div>
      );
    }

    // Show primary key as read-only (edit mode only)
    if (isReadOnly) {
      return (
        <div key={col.name} className="space-y-2">
          <Label htmlFor={col.name} className="text-muted-foreground">
            {col.name} (read-only)
          </Label>
          <Input
            id={col.name}
            value={String(value ?? "")}
            disabled
            className="bg-muted"
          />
        </div>
      );
    }

    switch (col.type) {
      case "boolean":
        return (
          <div key={col.name} className="flex items-center space-x-2">
            <Checkbox
              id={col.name}
              checked={!!value}
              onCheckedChange={(checked) => handleChange(col.name, checked)}
            />
            <Label htmlFor={col.name}>
              {col.name}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
          </div>
        );

      case "integer":
        return (
          <div key={col.name} className="space-y-2">
            <Label htmlFor={col.name}>
              {col.name}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={col.name}
              type="number"
              value={value as string}
              onChange={(e) => handleChange(col.name, e.target.value)}
              className={errors[col.name] ? "border-destructive" : ""}
            />
            {errors[col.name] && (
              <p className="text-sm text-destructive">{errors[col.name]}</p>
            )}
          </div>
        );

      case "timestamp":
        return (
          <div key={col.name} className="space-y-2">
            <Label htmlFor={col.name}>
              {col.name}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={col.name}
              type="datetime-local"
              value={value as string}
              onChange={(e) => handleChange(col.name, e.target.value)}
              className={errors[col.name] ? "border-destructive" : ""}
            />
            {errors[col.name] && (
              <p className="text-sm text-destructive">{errors[col.name]}</p>
            )}
          </div>
        );

      case "json":
        return (
          <div key={col.name} className="space-y-2">
            <Label htmlFor={col.name}>
              {col.name}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Textarea
              id={col.name}
              value={value as string}
              onChange={(e) => handleChange(col.name, e.target.value)}
              placeholder="Enter valid JSON..."
              className={`font-mono text-sm ${errors[col.name] ? "border-destructive" : ""}`}
            />
            {errors[col.name] && (
              <p className="text-sm text-destructive">{errors[col.name]}</p>
            )}
          </div>
        );

      case "text":
      default:
        return (
          <div key={col.name} className="space-y-2">
            <Label htmlFor={col.name}>
              {col.name}
              {isRequired && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={col.name}
              type="text"
              value={value as string}
              onChange={(e) => handleChange(col.name, e.target.value)}
              className={errors[col.name] ? "border-destructive" : ""}
            />
            {errors[col.name] && (
              <p className="text-sm text-destructive">{errors[col.name]}</p>
            )}
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            {columns.map((col) => renderField(col))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
