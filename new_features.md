

# Improvement
- Dont zoom after adding routes 
- Track manager should be visible in a sidebar, instead of a sheet component.
- In "plan mode", the cursor should be a cross/+ cursor 
- Clicking a second time on a marker should remove it and recompute the markers numbers. 
- Routes should be available to be saved in the tracks manager, first as temporary track, and the user could save them as permanant. 
- the routes layer style should be larger and have an clear white outline, with an 0.8 opacity 
- Each track, permanant and temprary (just created) should be exportable as gpx file 

- The clear button should add a dialog "Are you sure", using shadui dialog 

npx shadcn@latest add alert-dialog


import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

<AlertDialog>
  <AlertDialogTrigger>Open</AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone. This will permanently delete temporary tracks and way points. Saved track will not be affected.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction>Continue</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>



