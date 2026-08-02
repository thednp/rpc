import "./style.css";
import { setupForm, setupGetTime, setupGreeting } from "./hydrate";

setupGreeting(document.querySelector("h1") as HTMLHeadingElement);
setupForm(document.getElementById("addForm") as HTMLFormElement);
setupGetTime(document.getElementById("timeForm") as HTMLFormElement);
