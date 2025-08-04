import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface InputDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label: string
  placeholder?: string
  defaultValue?: string
  onConfirm: (value: string) => void
  confirmText?: string
  cancelText?: string
  validation?: (value: string) => boolean | string
}

export function InputDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  defaultValue = "",
  onConfirm,
  confirmText = "Save",
  cancelText = "Cancel",
  validation
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string>("")

  // Effect to sync state with prop changes
  useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  const handleConfirm = () => {
    if (validation) {
      const result = validation(value)
      if (result !== true) {
        setError(typeof result === "string" ? result : "Invalid input")
        return
      }
    }
    
    onConfirm(value)
    onOpenChange(false)
    setValue(defaultValue)
    setError("")
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      // Reset state when dialog opens
      setValue(defaultValue)
      setError("")
    }
    onOpenChange(newOpen)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && (
            <DialogDescription>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="input-field">{label}</Label>
            <Input
              id="input-field"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className={error ? "border-red-500" : ""}
            />
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{cancelText}</Button>
          </DialogClose>
          <Button onClick={handleConfirm}>
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
